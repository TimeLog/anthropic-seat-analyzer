// Headless verification of seat-analyzer.html core logic against real admin exports.
// All expectations are derived from the CSVs at runtime — no emails or usage figures
// live in this file. Exact verdict lists can optionally be pinned in a gitignored
// expectations.json (generate with --write-expectations).
//
// Usage: node verify.js [--write-expectations]
//        DATA_DIR=/path node verify.js        (CSVs default to ~/Downloads)
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dataDir = process.env.DATA_DIR || path.join(process.env.HOME, 'Downloads');
const html = fs.readFileSync(path.join(__dirname, 'seat-analyzer.html'), 'utf8');

// extract the core (DOM-free) script
const m = /<script id="core">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('FAIL: core script not found'); process.exit(1); }
const mod = { exports: {} };
new Function('module', 'exports', m[1])(mod, mod.exports);
const core = mod.exports;

const spendName = fs.readdirSync(dataDir).find(f => f.startsWith('spend-report-') && f.endsWith('.csv'));
const membersName = fs.readdirSync(dataDir).find(f => f.startsWith('members-') && f.endsWith('.csv'));
if (!spendName || !membersName) {
  console.error(`FAIL: expected spend-report-*.csv and members-*.csv in ${dataDir} (set DATA_DIR to override)`);
  process.exit(1);
}
const spendText = fs.readFileSync(path.join(dataDir, spendName), 'utf8');
const membersText = fs.readFileSync(path.join(dataDir, membersName), 'utf8');

const win = core.parseWindowFromFilename(spendName);
const months = core.monthsBetween(win.start, win.end);
console.log(`data: ${dataDir}`);
console.log(`window ${win.start} → ${win.end}  (${months.toFixed(3)} months)`);

const SAFETY = 0.8;
const R = core.analyze(core.parseCSV(spendText), core.parseCSV(membersText), { months, safety: SAFETY });
const V = core.VERDICTS;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// 1. per-user overage totals vs independent awk sums of the raw file
const awk = cp.execSync(
  `awk -F, 'NR>1 && $1!="" {s[tolower($1)]+=$8} END {for (e in s) printf "%s %.2f\\n", e, s[e]}' "${path.join(dataDir, spendName)}"`,
  { encoding: 'utf8' });
const awkMap = new Map(awk.trim().split('\n').map(l => {
  const i = l.lastIndexOf(' ');
  return [l.slice(0, i), parseFloat(l.slice(i + 1))];
}));
const overageMismatches = [];
for (const u of R.users) {
  const expected = awkMap.get(u.email) ?? 0;
  if (Math.abs(u.overage - expected) > 0.005) overageMismatches.push(`${u.email}: app=${u.overage.toFixed(2)} awk=${expected.toFixed(2)}`);
}
check('per-user overage totals match awk sums', overageMismatches.length === 0,
  overageMismatches.join('; ') || `${R.users.length} users compared`);

// 2. join completeness — member count comes from the members CSV itself
const memberCount = core.parseCSV(membersText).length;
check(`join finds all ${memberCount} members`, R.users.length === memberCount, `got ${R.users.length}`);

// 3. verdicts re-derived by an independent implementation of the classification rules.
//    If you deliberately change the rules in analyze(), update this copy too — a
//    mismatch here means the two implementations have drifted apart.
const bench = R.users.filter(u => u.tier === 'Standard' && u.overage === 0)
  .reduce((a, u) => (!a || u.tokens > a.tokens) ? u : a, null);
check('benchmark = highest-volume standard user with $0 overage',
  (R.benchmark && bench && R.benchmark.email === bench.email) || (!R.benchmark && !bench),
  R.benchmark ? R.benchmark.email : '(none)');

const threshold = 100 * SAFETY;
const expectedVerdict = u => {
  if (u.tier === 'Premium') {
    if (u.overage > 0) return V.KEEP;
    if (bench && u.tokens >= bench.tokens && u.estValue >= bench.estValue) return V.HEAVY;
    return V.DOWN;
  }
  if (u.monthlyOverage >= threshold) return V.UP;
  if (u.overage > 0) return V.OK_OVER;
  return V.WITHIN;
};
const verdictMismatches = R.users.filter(u => u.verdict !== expectedVerdict(u))
  .map(u => `${u.email}: app=${u.verdict} expected=${expectedVerdict(u)}`);
check('all verdicts match independent re-derivation', verdictMismatches.length === 0,
  verdictMismatches.slice(0, 5).join('; ') || `${R.users.length} verdicts agree`);

// 4. peer-based cost projections re-derived and internally consistent
const projMismatches = [];
for (const u of R.users) {
  if (u.verdict === V.DOWN) {
    const peers = R.users.filter(p => p !== u && p.tier === 'Standard' && p.hasSpend
      && p.estValue >= u.estValue / 2 && p.estValue <= u.estValue * 2);
    const ov = peers.map(p => p.monthlyOverage).sort((a, b) => a - b);
    const mid = ov.length >> 1;
    const median = !ov.length ? 0 : (ov.length % 2 ? ov[mid] : (ov[mid - 1] + ov[mid]) / 2);
    if (Math.abs(u.projectedMonthly - (core.SEAT_PRICE.Standard + median)) > 1e-9)
      projMismatches.push(`${u.email}: projected=${u.projectedMonthly} expected=${core.SEAT_PRICE.Standard + median}`);
    if (Math.abs(u.switchSavings - (u.costNow - u.projectedMonthly)) > 1e-9)
      projMismatches.push(`${u.email}: switchSavings inconsistent`);
    if ((u.peer ? u.peer.count : 0) !== peers.length)
      projMismatches.push(`${u.email}: peer count ${u.peer ? u.peer.count : 0} != ${peers.length}`);
  } else if (u.verdict === V.UP) {
    if (u.projectedMonthly !== core.SEAT_PRICE.Premium) projMismatches.push(`${u.email}: upgrade projection != premium price`);
  }
}
check('peer projections re-derived and consistent', projMismatches.length === 0, projMismatches.join('; '));
const sumSwitch = R.users.reduce((s, u) => s + (u.switchSavings || 0), 0);
check('totals.netSavings = sum of switchSavings', Math.abs(R.totals.netSavings - sumSwitch) < 1e-9,
  core.fmtUSD(R.totals.netSavings) + '/mo');

// 5. optional pinned expectations for a specific export (gitignored — never in source)
const expPath = path.join(__dirname, 'expectations.json');
const snapshot = {
  spendFile: spendName,
  memberCount: R.users.length,
  benchmark: R.benchmark ? R.benchmark.email : null,
  downgrades: R.users.filter(u => u.verdict === V.DOWN).map(u => u.email).sort(),
  heavy: R.users.filter(u => u.verdict === V.HEAVY).map(u => u.email).sort(),
  upgrades: R.users.filter(u => u.verdict === V.UP).map(u => u.email).sort(),
  netSavings: +R.totals.netSavings.toFixed(2),
};
if (process.argv.includes('--write-expectations')) {
  fs.writeFileSync(expPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`wrote ${expPath} (gitignored)`);
} else if (fs.existsSync(expPath)) {
  const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  if (exp.spendFile !== spendName) {
    console.log(`note: expectations.json pins a different export (${exp.spendFile}) — skipping pinned checks`);
  } else {
    for (const k of ['memberCount', 'benchmark', 'netSavings']) {
      check(`pinned ${k}`, JSON.stringify(snapshot[k]) === JSON.stringify(exp[k]),
        `${JSON.stringify(snapshot[k])} vs pinned ${JSON.stringify(exp[k])}`);
    }
    for (const k of ['downgrades', 'heavy', 'upgrades']) {
      check(`pinned ${k} list`, JSON.stringify(snapshot[k]) === JSON.stringify(exp[k]),
        snapshot[k].join(', ') || '(empty)');
    }
  }
} else {
  console.log('note: no expectations.json — run with --write-expectations to pin exact verdicts for this export');
}

console.log(`\nbenchmark: ${R.benchmark ? `${R.benchmark.email}  tokens=${core.fmtNum(R.benchmark.tokens)}  estVal=${core.fmtUSD(R.benchmark.estValue)}` : '(none)'}`);
console.log(`totals: members=${R.totals.members} premium=${R.totals.premium} seatCost=${core.fmtUSD(R.totals.seatCost)}/mo ` +
  `monthlyOverage=${core.fmtUSD(R.totals.monthlyOverage)} downgrades=${R.totals.downgrades} upgrades=${R.totals.upgrades} net=${core.fmtUSD(R.totals.netSavings)}/mo`);
console.log(`unmatched members: ${R.unmatchedMembers.join(', ') || 'none'}`);
console.log(`unmatched spend: ${R.unmatchedSpend.map(x => x.email).join(', ') || 'none'}`);

console.log('\nFull verdict list:');
for (const u of [...R.users].sort((a, b) => a.verdict.localeCompare(b.verdict) || b.estValue - a.estValue)) {
  console.log(`  ${u.verdict.padEnd(30)} ${u.email.padEnd(22)} tier=${u.tier.padEnd(8)} ovg/mo=${core.fmtUSD(u.monthlyOverage).padStart(9)} tok=${core.fmtNum(u.tokens).padStart(7)} est=${core.fmtUSD(u.estValue).padStart(10)}`);
}

process.exit(failures ? 1 : 0);
