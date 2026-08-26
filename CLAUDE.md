# Seat Tier Analyzer

Single-file web app that analyzes Anthropic admin exports (spend report + member list)
and recommends seat-tier changes (Premium $125/mo ↔ Standard $25/mo).

## Layout

| File | Purpose |
|---|---|
| `seat-analyzer.html` | The entire app — HTML, CSS, and JS inline. No build step, no network requests. Open directly in a browser. |
| `verify.js` | Headless test harness (plain node, no deps). Extracts the app's core script and runs it against real CSV exports. |

`seat-analyzer.html` has **two script blocks**:

1. `<script id="core">` — **pure, DOM-free logic**: CSV parser, price table, `analyze()`,
   formatters. It exports via `module.exports` when run under node — `verify.js` depends on
   this. **Keep all business logic here and keep it DOM-free**, or the tests can't see it.
2. The second `<script>` — UI only (drop zones, rendering, chart SVG, table, localStorage).
   Exposes `window.__seatResult` (last analysis) and `window.__loadTexts(spendText, spendName,
   membersText)` for headless drivers.

## Critical domain semantics — do not get this wrong

`total_net_spend_usd` in the spend report is **OVERAGE**, not usage value: extra usage
credits billed at API rates *after* a user exceeds their seat's included limits.

- $0 overage + billions of tokens = the seat's included allowance covered everything
  (or the user was rate-limited — ambiguous, and the UI flags this).
- Token columns are the usage-volume signal; spend is only the exceeded-limits signal.
- Never treat spend as "how much value the user got" — that's what **estimated API value**
  (tokens × published API prices) is for.

## Classification rules (in `analyze()`)

- Premium + overage > 0 → **Keep premium** (exceeds even premium limits).
- Premium + $0 overage → compare against the **benchmark** = the highest-token-volume
  Standard user with $0 overage. Above the benchmark on *both* tokens and est. API value
  → **Premium OK (heavy)**; otherwise → **Downgrade candidate** (saves $100/mo).
- Standard + monthly overage ≥ $100 × safety factor (slider, default 0.8) → **Consider premium**.
- Standard + smaller overage → **Standard OK — overage is cheap**; $0 → **Within limits ($0)**.

## Peer-based cost projection (the decision layer)

Seat limits are burst rate-limits (5-hour sessions, weekly caps), **not** aggregate token
buckets — real exports show the "exceeded" and "within limits" populations overlapping by
orders of magnitude, so no absolute token cutoff exists. So for each downgrade candidate,
`analyze()` projects the standard-seat cost empirically: take standard users at ½–2× the
candidate's est. API value (`peerEstimate()`), use their **median monthly overage** as the
projected overage, and compute `switchSavings = costNow − (25 + median)`. Upgrade
candidates are projected at flat $125 (premium's 5× allowance assumed to absorb the
overage; `switchSavings` can be negative when the safety factor < 1 — that's intentional,
the user is buying throttle headroom). `totals.netSavings` sums `switchSavings` and drives
the "Potential savings" card and the Recommended-actions panel.

Join key: lowercased email. The spend report contains a `(org service usage)` row with an
empty model — it must never crash the analysis and shows up under "unmatched spend".

## Price table

`PRICES` in the core script, per MTok, from platform.claude.com (Aug 2026):
Fable 5 $10/$50 · Opus 5 $5/$25 · Opus 4.x $5/$25 · Sonnet 5 $2/$10 · Sonnet 4.x $3/$15 ·
Haiku 4.5 $1/$5. Cache reads = 10% of input; cache writes = 1.25× (5m) / 2× (1h).
Match is substring-based on the model id (`opus-5` must be checked before `opus-4`... order
matters only for correctness of new entries — keep more-specific matches first).
When new model families appear in exports, add a row; unknown models are surfaced per-user
as "unpriced models" rather than silently valued at $0 gone unnoticed.

## Verifying changes

```sh
npm test          # = node verify.js; reads CSVs from ~/Downloads (or DATA_DIR=...)
```

**No emails, names, or org-specific usage figures may appear in source** — the harness
derives every expectation from the CSVs at runtime:

- per-user overage sums are cross-checked against independent awk sums of the raw file;
- the join is complete (member count read from the members CSV);
- every verdict is re-derived by an **independent copy of the classification rules** in
  `verify.js` and must match `analyze()` exactly — if you deliberately change the rules,
  update both implementations;
- peer projections and `netSavings` are re-derived and checked for consistency.

Exact verdict lists for a specific export can be pinned in `expectations.json`
(**gitignored**, generated with `node verify.js --write-expectations`) — regenerate it
after intentional rule changes.

**Any change to `analyze()`, the CSV parser, or `PRICES` must keep `npm test` green.**
For UI changes, also open the page in a browser and load both CSVs via the pickers.

Sample exports and `expectations.json` live outside git (they contain employee emails —
see .gitignore; never commit CSVs or expectations). To obtain fresh exports from the
Claude admin console, see README → "Getting the exports".

## Conventions

- Everything stays in one HTML file; no external dependencies, no build step, no CDN —
  the app must work offline from `file://`.
- Settings (safety factor, date window) persist in `localStorage` under
  `seatAnalyzer.settings.v1` — bump the key on breaking shape changes.
- Dense internal-dashboard styling; dark theme via CSS variables in `:root`.
- Humane number formatting through `fmtNum` / `fmtUSD` — don't inline `toFixed` in the UI.
