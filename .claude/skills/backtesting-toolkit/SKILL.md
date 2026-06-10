---
name: backtesting-toolkit
description: Reference for the backtesting tools at python/backtest/ and python/monkey/ — signal attribution from Supabase, OHLCV price archive, multi-strategy historical replay with monkey baseline, news tagging, universe expansion. Use when the user wants to validate strategies, evaluate signal quality, expand the trading universe, run historical what-ifs, or interpret backtest results. Triggers: "backtest", "signal attribution", "monkey", "historical replay", "expand universe", "russell 2000", "what if", "validate", "edge", "is the bot working".
---

# Backtesting Toolkit — How to Validate Strategies for the Trading Bots

> Lives at `C:/Users/pc2/Desktop/binance-bot/python/`. Five tools, each runnable independently.

## Tool index

| Tool | Path | What it does | When to run |
|---|---|---|---|
| Signal attribution | `python/backtest/backtest_predictions.py` | Per-signal hit-rate, profit factor, fitted weights from Supabase resolved predictions | After each batch of 20+ resolved predictions |
| Price archive builder | `python/backtest/build_price_archive.py` | Downloads OHLCV for full universe over N years → Parquet | Once, refresh weekly |
| Historical replay | `python/backtest/historical_replay.py` | Multi-strategy backtest with monkey baseline, slippage, lookahead-safe features | After each strategy change |
| News tagger | `python/backtest/tag_news.py` | Tag predictions with news context (earnings/analyst/M&A flags) | After each batch of resolved predictions |
| Universe expander | `python/backtest/expand_universe.py` | Merge curated + S&P 500 + Russell 2000 + NASDAQ-listed → liquidity-filtered active list | Once, refresh quarterly |
| Monkey baseline | `python/monkey/monkey_baseline.py` | Standalone monkey simulation against actual `dailyPicks.json` | Weekly after dailyPicker is wired |

## Foundation: bug fixes that made it all work

Before any backtest could run, two bugs blocked outcome resolution:

1. **`db.js:153`** — read `pred.predicted_days` (column doesn't exist) instead of `pred.timeframe_days` (the actual column). Fixed.
2. **`index.js:644`** — cron `0 17 * * 1-5` had no timezone, so 17:00 in Italy fired at 11:00 ET (mid-trading day). Fixed with `{ timezone: 'America/New_York' }`. Same fix applied to `index.js:680` (10:00 ET morning resolver).

Both fixes shipped. After fix, `node server/scripts/backfillPredictions.js` resolved the stuck 192 predictions → 119 with real outcomes.

If `predictions.outcome` is null on most rows, **check these two bugs first** before anything else.

---

## Signal attribution — what we learned from 119 outcomes

Real numbers from `python python/backtest/backtest_predictions.py` (May 2026):

### Overall (all signals combined)
| Metric | Value |
|---|---|
| Resolved predictions | 119 |
| Win rate (hit ≥50% of target) | 47.1% |
| Strict win rate (full target) | 42.0% |
| Average return | +1.00% |
| Profit factor | 1.25 |
| Best single | +55.06% |
| Worst single | −30.29% |

### Top performers (counterintuitive findings)

| Signal | n | hit% | avg return | PF | Default wt | Fitted wt |
|---|---|---|---|---|---|---|
| **volume_contraction** | 29 | **69.0%** | **+6.53%** | **4.93** | 6 | **30.2** ← bot under-weights this 5× |
| **call_sweep_large** | 14 | 64.3% | +4.90% | 4.19 | 24 | 19.2 |
| **smart_money** | 5 | 60.0% | +2.26% | 1.69 | 16 | 6.3 |
| bb_squeeze | 83 | 51.8% | +2.16% | 1.63 | 12 | 21.4 |
| price_compression | 60 | 51.7% | +1.21% | 1.34 | 8 | 20.6 |
| momentum_acceleration | 69 | 50.7% | +1.02% | 1.25 | 15 | 19.9 |

### Worst performers (signals to demote)

| Signal | n | hit% | avg return | PF |
|---|---|---|---|---|
| **options_volume_spike** | 19 | 26.3% | **−3.37%** | 0.40 |
| **put_call_bullish** | 27 | 33.3% | **−3.51%** | 0.40 |
| short_squeeze_loading | 35 | 31.4% | −2.13% | 0.55 |
| analyst_momentum | 11 | 36.4% | −1.72% | 0.63 |
| put_call_extreme_bullish | 33 | 45.5% | −1.25% | 0.72 |
| bullish_options | 98 | 42.9% | −0.64% | 0.85 |

**Insight**: most of the "bullish options flow" signals are negative or break-even. Options flow looks impressive but doesn't translate to next-day returns at this scale. The bot's `optionsScanner.js` weights are net-detrimental.

### Killer combos (n ≥ 5)

| Combo | n | hit% | avg | PF |
|---|---|---|---|---|
| call_sweep_large + put_call_extreme_bullish | 6 | 83.3% | +10.39% | 39.49 |
| call_sweep_large + momentum_acceleration | 11 | 81.8% | +7.21% | 8.36 |
| sector_lag + volume_contraction | 10 | 80.0% | +7.94% | 5.38 |
| deep_itm_calls + volume_contraction | 6 | 83.3% | +9.45% | 9.31 |
| call_sweep_large + reddit_trending | 5 | 80.0% | +7.50% | 10.44 |
| institutions_accumulating + multi_day_accumulation | 9 | 77.8% | +8.83% | 15.68 |

### Gem score calibration is BROKEN

| Bucket | n | avg return | win% |
|---|---|---|---|
| 60–69 | 9 | **+5.90%** | **77.8%** |
| 70–79 | 28 | +0.80% | 42.9% |
| 80+ | 82 | +0.53% | 45.1% |

Higher gemScore → LOWER returns. The bot's most confident picks underperform its medium-confidence picks. Strong evidence that `calculateGemScore` weights are mis-calibrated — likely because the high-scoring buckets overfit to options-flow signals (which we now know are negative).

---

## Historical replay — strategies tested

Run with `python python/backtest/historical_replay.py --strategy <name>`. Window 2024-01-01 to 2026-04-30 over 238-symbol archive, $20M ADV floor, 10 bps round-trip slippage, look-ahead-safe (features lagged 1 day).

| Strategy | Total return | Win rate | Sharpe | Max DD | Monkey % |
|---|---|---|---|---|---|
| **SPY benchmark** | +52.0% | 57% | 1.21 | −19% | n/a |
| Composite (mom+vol+revert) | −31.3% | 49.3% | 0.63 | −85% | 41.6th |
| Random (monkey check) | −52.5% | 48.1% | −0.27 | −80% | 25.6th |
| Volume spike | −82.6% | 46.6% | 0.06 | −89% | 3.2nd |
| Momentum (5d) | −87.9% | 47.1% | 0.21 | −96% | 1.2nd |
| Mean reversion | −100% | 32% | −4.16 | −100% | 0th |

**Honest read**: simple price/volume strategies on the small/mid-cap universe are catastrophic. Even the best (composite) sits below 50th-percentile monkey. Buy-and-hold SPY beats every strategy by a wide margin. **No price-only strategy on this universe has demonstrated edge.** This is exactly the kind of finding the monkey baseline is designed to surface.

The bot's actual signals (when correctly weighted using fitted weights from §1) do better than these — but we haven't replayed those because the historical archive doesn't have options/insider/dark-pool history.

---

## How to run the full validation cycle

```bash
# 1. Resolve predictions (only needed once after the bug fixes)
node server/scripts/backfillPredictions.js

# 2. Signal attribution
cd python/backtest
python backtest_predictions.py
# → signal_attribution.json

# 3. (Optional) tag news context
python tag_news.py
# → news_tags.json

# 4. Build/refresh price archive
python build_price_archive.py --years 3
# → archive/ohlcv_daily.parquet (~6.5MB, 238 syms × 3y)

# 5. Run multi-strategy replay
python historical_replay.py \
  --strategy momentum --strategy volume_spike --strategy composite --strategy random \
  --start 2024-01-01 --end 2026-04-30 \
  --min-dollar-volume 20000000 --slippage-pct 0.10
# → replay_results/replay_report.json + per-strategy picks CSVs

# 6. (Optional) expand universe
python expand_universe.py --target-size 1500
# → universe_expanded.json (~5224 raw) + universe_active.json (~1500 liquid)
```

## Universe expansion (May 2026)

Source totals: curated 262 + S&P 500 (503) + Russell 2000 (1928) + NASDAQ-listed (4038) = **5,224 unique symbols pre-filter**.

After liquidity filter ($1-$500 price, $5M+ avg dollar volume, 20-day lookback), expect ~1500-2000 active. Output goes to `python/monkey/universe_active.json`. To use it as the bot universe, point `premarketScanner.js STOCK_UNIVERSE.ALL` at this file (or merge programmatically).

**Don't blindly switch the live bot to a 1500-symbol universe** without:
- Re-running the price archive at the new size (~30 min)
- Re-running the signal attribution at the new size
- Verifying the `*/5` cron still finishes in <5 min on the bigger universe (probably won't — Yahoo rate limits)

---

## Critical pitfalls (we already hit some)

1. **Look-ahead bias**: features computed from day-t close cannot inform day-t open-to-close trade. `add_features` in `historical_replay.py` shifts features by 1 day per symbol — required.
2. **Slippage is mandatory**: 10 bps round-trip minimum; without it, micro-cap strategies show fake giga-returns.
3. **Liquidity floor matters**: $5M ADV minimum; below that the strategy "picks" stocks you couldn't actually buy.
4. **Survivorship bias**: 24 of the 262 curated symbols delisted between 2023-2026. Backtests using only the survivors over-state edge. This is unavoidable without a true point-in-time universe DB but the gap is documented in `archive_build.log`.
5. **News timestamps are NOT point-in-time**: `tag_news.py` uses yfinance's current news cache; older predictions get partial coverage. Treat news flags as suggestive, not determinative. For real point-in-time news → Polygon News, Benzinga, or NewsAPI historical (paid).
6. **Statistical significance**: 119 outcomes is barely enough for per-signal directional reads (the n=5-30 signals especially). Need 250+ outcomes for tighter conclusions, 1000+ for combos.

## What this toolkit can NOT do

- Backtest options/insider/dark-pool/Reddit signals historically (data not archived)
- Replay the bot's *exact* live decisions (those depend on real-time Yahoo state we didn't snapshot)
- Prove a strategy works going forward — backtest-pass is necessary but not sufficient
- Eliminate survivorship bias from current curated universe

For these, the path is forward-walking validation: run `dailyPicker` Telegram-only for 6+ weeks, then run the monkey baseline on actual picks (`python/monkey/monkey_baseline.py`).

## Files & artifacts

```
python/
├── backtest/
│   ├── backtest_predictions.py     signal attribution
│   ├── build_price_archive.py      Yahoo → Parquet downloader
│   ├── historical_replay.py        multi-strategy backtester
│   ├── tag_news.py                 news context tagger
│   ├── expand_universe.py          curated + S&P + Russell + NASDAQ merger
│   ├── archive/
│   │   ├── ohlcv_daily.parquet     174,919 rows × 238 symbols × 3y
│   │   └── ohlcv_meta.json         archive metadata
│   ├── replay_results/
│   │   ├── replay_report.json      latest replay summary
│   │   └── *_picks.csv             per-strategy daily picks
│   ├── signal_attribution.json     latest signal-quality readout
│   └── news_tags.json              latest news-tagged predictions
└── monkey/
    ├── monkey_baseline.py          dailyPicks vs random monkeys
    ├── universe.json               curated 262 (matches premarketScanner.js)
    ├── universe_expanded.json      5224 raw merged
    └── universe_active.json        ~1500 liquidity-filtered tradable
```

## Next-step recipes

**"Is the bot working?"** → §1 Signal attribution. Look for fitted weights ≥2× default and PF >1.5.

**"Should I trust the gem score?"** → §1 gem score bucket table. If higher score ≠ higher returns, calibration is broken.

**"What if I traded only X signal?"** → Filter `predictions` table by signal in thesis, compute outcome stats.

**"What if I had used different universe?"** → Run `expand_universe.py` then rebuild archive then rerun replay.

**"Could I have made money over the last 2 years?"** → §2 Historical replay. Compare strategy total return to SPY +52% benchmark.

**"Is my edge real or luck?"** → Monkey percentile from §1 or replay output. >75th sustained = real, <50th = luck/noise.
