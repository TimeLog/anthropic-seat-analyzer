# Seat Tier Analyzer

Internal tool: load two Anthropic admin exports and get per-user seat-tier recommendations
(who to downgrade from Premium, who genuinely needs it, who should upgrade), with monthly
savings totals.

## Getting the exports

Both come from the Claude admin console (requires an admin/owner role):

| Export | Where | How |
|---|---|---|
| **Spend report** | <https://claude.ai/analytics/overview> | "How much is Claude costing?" → **Export spend report** button. Filename: `spend-report-<org>-YYYY-MM-DD-to-YYYY-MM-DD.csv` |
| **Member list** | <https://claude.ai/admin-settings/members> | **Export CSV** button. Filename: `members-<org>-YYYY-MM-DD.csv` |

Keep the original filenames — the analysis window is parsed from the spend report's
filename (editable in the UI if needed).

## Use

1. Open `index.html` in any browser (double-click — no server, no build, no
   network; the CSVs are parsed locally and never leave your machine).
2. Drop the two exports onto the drop zones (either file on either zone — they're routed
   by content).
3. Read the recommended actions, cards, chart, and per-member table. Click a row for
   per-product / per-model breakdowns. Tune the upgrade safety factor with the slider
   (persisted locally).

## Key concept

`total_net_spend_usd` is **overage** (credits billed after exceeding the seat's included
limits), not usage value. A user with $0 spend and 4B tokens cost nothing extra — the seat
covered it. The app therefore ranks users by *estimated API value* (tokens × published API
prices, cache-aware) and uses overage only as the exceeded-limits signal.

## Development

See `CLAUDE.md` for architecture and rules. Run the regression harness with:

```sh
npm test                      # CSVs read from ~/Downloads
DATA_DIR=/path/to/exports npm test
```

Never commit export CSVs — they contain employee emails.

## License

[MIT](LICENSE)
