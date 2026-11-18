[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/egilolriot/Bounty-Twitch-Forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/egilolriot/Bounty-Twitch-Forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

# Forecasting GTA VI's launch-day Twitch viewers

Entry for the [make.fun bounty gta6-twitch-ccu-forecast-01](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) — forecast how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day, 19 November 2026 (UTC), given only the first hour's viewer count. For hours 2–24 the program writes five quantiles (5%, 25%, 50%, 75%, 95%) of each hour's concurrent-viewer count.

Owner: **egilolriot** · Repo: **Bounty-Twitch-Forecast** · Referral code: **zegsd6t5** ([make.fun/r/zegsd6t5](https://make.fun/r/zegsd6t5))

## The model

GTA VI unlocks at midnight local time, rolling country by country, so the right analogues are past launches that unlocked the same way — not simultaneous-global launches (whose hour-1 count is near-zero pre-unlock noise) and not early-access launches (whose peak already happened days before release day). The program filters each case's own comparables to that rolling-midnight set using the unlock note plus a data guard (all 24 release-day hours present, hour 1 at least 1,000 viewers and at least 2% of the day's peak), then takes the median ratio of viewers(h) to viewers(1) for each hour as the shape of the day: a dip to about 0.78× in the small hours, a climb from the US unlocks, and a peak near 2.5× around 18:00–19:00 UTC. The spread around that median comes from the interquartile range of the log ratios across the kept games (a robust scale estimate, floored at 0.20). A scale adjustment then shrinks the evening rise when hour 1 is already huge — a big first hour means most of the world is already watching, so there is less left to add — using the per-hour regression slope of the log ratio on the log hour-1 count, applied at half strength and clamped so the factor stays between 0.45 and 1.6. If fewer than five comparables survive the filter, a hardcoded curve fitted on the practice set is used instead. Everything is computed at runtime from the case's own comparables; the program is deterministic, uses only the Node standard library, and runs in well under a second per case.

## Practice results

Scored on the four practice cases (Marvel's Wolverine, Red Dead Redemption 2, God of War Ragnarök, Marvel's Spider-Man 2) against their SullyGnome hourly counts, mean pinball loss on the log scale:

| case | loss | typical miss | 90% coverage |
|---|---|---|---|
| p00 Wolverine | 0.278659 | 52.19% | 0.696 |
| p01 Red Dead Redemption 2 | 0.114580 | 17.38% | 0.957 |
| p02 God of War Ragnarök | 0.141335 | 27.12% | 0.957 |
| p03 Spider-Man 2 | 0.221758 | 40.64% | 0.739 |
| **mean** | **0.189083** | **~34%** | **~0.84** |

The house baseline (flat at hour 1, widening spread) scores about **0.387** on the same practice cases, and a flat hour-1 forecast scores 0.603 — so this entry is roughly twice as good as the baseline. Leave-one-out validation over the rolling-midnight comparables (each launch forecast from the other nine) gives a mean loss of 0.270 against 0.573 for the flat forecast, so the advantage is not just fitted to the four practice cases. The worst practice case is Wolverine: small hour-1 launches can run to ~9× by the evening, a tail no median curve captures — the evening spread (log σ ≈ 0.4–0.5) is the honest price of that.

## How to run it

Node 22, no dependencies, no network:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `<id>.in` in the input directory and writes one `<id>.out` forecast per case to the output directory. With no environment variables set it reads `/input` and writes `/output`, as the grader runs it. A single case takes about 0.05 s (about 0.2 s including Node startup for a four-case run), far under the 8 s limit, and two runs on the same input are byte-identical.

`score.mjs` (practice scorer, not part of the entry) reproduces the numbers above:

```sh
node score.mjs <output-dir> <answers.json> [input-dir]
```

## Files

- `main.ts` — the entry: input/output, validation, and the model.
- `score.mjs` — practice and leave-one-out scorer (development aid).
- `ANALYSIS.md` — working note from the data analysis behind the model (not part of the entry).
- `LICENSE` — MIT.

## Limitations

- The final is a single case and GTA VI is bigger than any comparable, so the scale adjustment extrapolates beyond the fitted range; half strength plus the factor clamp limits that risk, but it is still an extrapolation.
- Practice answers are SullyGnome hourly averages while the final's prints are minute-mean Twitch GraphQL reads — the same quantity in spirit, with a small definitional gap.
- A Wolverine-style evening run (~9× hour 1) cannot be ruled out if hour 1 prints small; the spread is deliberately kept wide in the evening rather than narrowed to chase the practice score.
