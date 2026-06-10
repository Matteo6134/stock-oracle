---
name: lstm-trading-v2
description: Reference for building an LSTM-based stock prediction layer as v2/v3 of the existing stock-oracle bot. Covers LSTM architecture for finance, feature engineering from Yahoo/Finnhub data, walk-forward backtesting, the dart-throwing-monkey statistical baseline, day-trading execution via Alpaca MOO/MOC, position sizing, and honest evaluation. Use when implementing or designing the LSTM predictor service, debating model architecture, building backtests, validating against monkey baseline, or transitioning from paper to live. Triggers: "LSTM", "neural network", "deep learning bot", "monkey baseline", "v2 model", "predict next day", "open to close", "MOO MOC", "walk-forward".
---

# LSTM Stock Predictor — v2 Architecture & Implementation Guide

> Honesty disclaimer: LSTMs on raw OHLCV barely beat naive baselines after costs in published research. The realistic v2 is to add LSTM as **signal #19** alongside the existing 18 handcrafted signals in `tomorrowMovers.calculateGemScore`, not as a replacement. The monkey baseline is the only honest validation.

---

## 1. Slot into existing architecture

```
[NEW] server/services/lstmPredictor.js         signal source, fronts Python sidecar
[NEW] python/lstm/                              training + inference
        train.py                                walk-forward training
        inference_server.py                     FastAPI on :5001 exposing /predict
        monkey_baseline.py                      validation harness
        features.py                             pure-function builder
        models/lstm_v1.h5                       serialized weights
[EXTEND] historicalBacktest.js                  add LSTM strategy
[EXTEND] signalLearner.js                       auto-weights lstm_score after outcomes
[EXTEND] autoTrader.js                          gate: lstm_confidence > 0.6
```

Cron: nightly `5 16 * * 1-5` after market close. Output `lstm_score` (0-100) injected as a new signal in `tomorrowMovers.js` weighted at default 12, then learned.

---

## 2. Architecture (Keras/TF)

```python
inputs  = Input(shape=(20, n_features))         # 20-day lookback
x = LSTM(64, return_sequences=True)(inputs)
x = LSTM(32)(x)
x = Dropout(0.3)(x)
x = Dense(32, activation='relu')(x)
out = Dense(3, activation='softmax')(x)         # P(down|flat|up)

model.compile(optimizer=Adam(1e-3),
              loss='sparse_categorical_crossentropy',
              metrics=['accuracy'])
```

- **Two LSTM layers max** on <5 years of data. More = memorize noise.
- **Dropout 0.3-0.5** — heavy regularization for noisy financial data.
- **Classification not regression**: returns are heavy-tailed; MSE is dominated by 5σ events that are unpredictable. P(up) maps to position size.

---

## 3. Features (25-40 per stock per day)

```python
features_per_stock = [
    # Price/volume normalized
    'ret_1d','ret_5d','ret_20d',
    'log_volume','volume_zscore_20d',
    'high_low_pct','close_to_vwap',
    'rsi_14','rsi_5',
    'bb_pct',                  # position within Bollinger
    'atr_pct',                 # ATR / price
    'sma_20_ratio','sma_50_ratio',
    'momentum_3d','momentum_5d',
    # Macro broadcast
    'vix','vix_change',
    'spy_ret_1d','tlt_ret_1d','dxy_ret_1d',
    # Slow fundamentals
    'short_pct','float_log','market_cap_log',
    # Sentiment (reuse existing services)
    'news_sentiment_score',     # claudeBrain or VADER
    'reddit_mention_zscore',    # socialSentiment.js
    'stocktwits_bull_pct',      # stocktwits.js
]
```

**Normalization rules** (CRITICAL):
- **Per-stock z-score** for volume/price-derived (NVDA's $5 ≠ PLTR's $5)
- **Cross-sectional rank** for relative momentum (rank within universe each day)
- **Static log-transform** for skewed (volume, market cap)
- **Macro features**: rolling 252-day z-score
- **Fit scaler ONLY on train period**, freeze, apply to val/test/live. Pickle the scaler.

**Cleaning**: forward-fill ≤2 days; drop otherwise. Cap outliers at 3σ. Single delisted-ticker 1000% move will dominate loss.

---

## 4. Target

Predict **next-day open-to-close return**:
```python
y_continuous = (close[t+1] - open[t+1]) / open[t+1]
y_class      = pd.cut(y_continuous, bins=[-inf, -0.005, 0.005, inf], labels=[0,1,2])
```

Why open-to-close (not close-to-close):
- Matches execution: buy MOO, sell MOC
- Removes overnight gap (untradable, news-driven, different distribution)
- Stationary

---

## 5. Walk-Forward Validation (NO random splits)

```
TRAIN: 2018-01 .. 2021-12        (4 yrs)
VAL:   2022-01 .. 2022-06        (6 mo, hyperparam tuning only)
TEST:  2022-07 .. 2023-12        (1.5 yrs, run ONCE at end)

Then walk: shift each window by 6 months, retrain, evaluate.
```

NEVER `train_test_split(shuffle=True)` on time series — neighboring rows correlate, you leak via time-adjacency.

---

## 6. Lookahead Bias — 5 silent killers

1. **Adjusted close**: Yahoo's adjustments use future dividends/splits. Use unadjusted, rebuild adjustments using only past events.
2. **Survivorship**: today's S&P list excludes bankruptcies. Use point-in-time membership.
3. **Restated fundamentals**: today's database holds restated numbers. Use vintage data.
4. **Normalization on full sample**: see §3.
5. **Centered windows**: a 20-day MA centered on today leaks 10 days. Always trailing-only.

**Validation trick**: build features as `f(asof_date) -> features`. Run `f(yesterday)` today, run `f(yesterday)` again tomorrow — outputs MUST be identical. If they differ, you have look-ahead.

---

## 7. The Monkey Baseline (mandatory)

```python
def simulate_monkey(returns_panel, n_days, n_monkeys=10_000, seed=42):
    """returns_panel: DataFrame rows=days cols=tickers vals=O2C return"""
    rng = np.random.default_rng(seed)
    universe = returns_panel.columns.tolist()
    daily_picks = rng.integers(0, len(universe), size=(n_monkeys, n_days))
    monkey_rets = np.zeros((n_monkeys, n_days))
    for i in range(n_days):
        monkey_rets[:, i] = returns_panel.iloc[-n_days+i].values[daily_picks[:, i]]
    cum = (1 + monkey_rets).prod(axis=1) - 1
    return cum
```

**Pass/fail thresholds**:
- AI < median monkey → **kill model**
- AI 50-90th percentile → **probably noise**, keep testing
- AI >95th percentile across MULTIPLE non-overlapping windows → maybe real

Run on **same days, same universe** as the AI test. Comparing to SPY is wrong — SPY is a single portfolio out of millions.

---

## 8. Statistical Significance

To prove a 5% edge with 60% volatility:
```
n ≈ (1.96 * 0.6 / 0.05)² ≈ 553 trading days ≈ 2+ years
```

**Don't switch from paper to live based on weeks**. Use rolling 3-month performance vs monkey as the live gate. Need t-statistic > 2 of `(AI_return - monkey_mean) / monkey_std` per quarter.

---

## 9. Live Pipeline (nightly, after close)

```python
# Cron 16:05 ET, M-F
universe = load_universe(date=today)                       # ~300 syms
features = build_features(universe, asof=today)            # pure function
preds    = model.predict(features)                         # P(up_strong) per sym
ranked   = sorted(zip(universe, preds[:,2]), key=lambda x: -x[1])
top      = ranked[0]

if top.confidence > 0.6:
    queue_alpaca_order(top.symbol, qty, side='buy', tif='opg')   # MOO
    queue_alpaca_order(top.symbol, qty, side='sell', tif='cls')  # MOC
```

In stock-oracle codebase: `lstmPredictor.js` cron writes `lstm_score`+`lstm_confidence` into the gem cache, `tomorrowMovers.calculateGemScore` picks it up next morning, `autoTrader.js` adds gate `lstm_confidence > 0.6`.

---

## 10. Universe (200-300 syms)

Reuse `STOCK_UNIVERSE` from `premarketScanner.js:11-119`. Daily rank by:
- Avg dollar volume > $5M (liquidity)
- Price ≥ $1 (already enforced)
- No earnings within 2 days
- Optionable

Wider universe = wider monkey distribution = harder to beat by luck = stronger evidence when you do.

---

## 11. Execution

**MOO/MOC orders via Alpaca**:
```python
order = MarketOrderRequest(
    symbol='NVDA', qty=10, side=OrderSide.BUY,
    time_in_force=TimeInForce.OPG)              # opening cross
```
- MOO submission deadline: 9:28 ET
- MOC submission deadline: 15:50 ET
- Hold time: open to close (~6.5h)

**No overnight holds** — model wasn't trained on overnight gap distribution.

**PDT under $25k**: 3 day trades / 5-day rolling window — your gold bot already hits this. Plan: LSTM bot needs its own ≥$25k Alpaca account (third one).

---

## 12. Position Sizing

Quarter Kelly with conviction scaling:
```python
def position_size(p_up, predicted_return, equity):
    edge   = predicted_return                   # e.g. 0.012
    odds   = 0.02                               # avg loss if wrong
    kelly  = edge / odds
    sized  = max(0.02, min(0.15, kelly * 0.25)) # 25% Kelly, clamp 2-15%
    return sized * equity
```

Conviction tiers:
- `P(up_strong) > 0.65` → full sized Kelly
- `0.55-0.65` → half
- `< 0.55` → SKIP

Risk controls (steal from `autoTrader.js`):
- Max single position: 15% equity
- Max daily loss: 3% → kill switch
- 3 consecutive losses → cooldown next day
- Correlation guard: don't load 5 semis

---

## 13. Honest Limitations

The 5 ways the model fools you (ranked by deadliness):

1. **Overfitting** — tuned 200 configs, reported best. Defense: walk-forward, report worst window not best.
2. **Survivorship** — point-in-time universe.
3. **Regime shift** — 2010-2019 was uniquely benign. Include 2008/2020/2022 in train. Stress-test per regime.
4. **Look-ahead** — pure-function feature builder, replay test (§6).
5. **Data snooping** — features should be hypothesis-driven, not chart-watching.

**Key metric**: out-of-sample Sharpe / in-sample Sharpe ≥ 0.7. If 0.3, curve-fit.

---

## 14. Key Metrics (rolling, live)

| Metric | Threshold |
|---|---|
| Directional accuracy | >52% sustained |
| Sharpe ratio | >1.0 backtest, >0.7 live |
| Max drawdown | <20% |
| Calmar (return/MDD) | >0.5 |
| % profitable months | >55% |
| Live monkey percentile | >75th sustained |
| OOS/IS Sharpe | ≥0.7 |
| Realized slippage | <25 bps |

Track all in a Supabase `lstm_perf` table; emit weekly Telegram digest.

---

## 15. Continuous Improvement

1. **Monthly walk-forward retrain** — last full month gets added to training.
2. **Drift monitor** — KL divergence between training and live feature histograms, weekly. Threshold: 2σ shift → retrain.
3. **Live monkey** — weekly. Drop below 75th pct for 4 weeks → reduce size to 25%. Below 50th → pause.
4. **Feature ablation** — quarterly. Drop features that don't move accuracy. Simpler = drifts less.
5. **Hypothesis-driven features only** — not "throw 47 indicators and see what sticks."
6. **Treat as signal #19** — let `signalLearner.js` weight it based on outcomes, blended 70/30 with default.

---

## 16. Recommended Build Order

| Step | Time | Output |
|---|---|---|
| 1. Feature pipeline | 1 week | `python/lstm/features.py` pure function |
| 2. Walk-forward harness | 3 days | extends `historicalBacktest.js` |
| 3. Monkey simulator | 1 day | `python/lstm/monkey_baseline.py` |
| 4. LSTM v0 train+eval | 1 week | kill if < median monkey |
| 5. Paper trading separate Alpaca account | 3 months | live monkey rolling pass |
| 6. 25% Kelly real money, isolated account | ongoing | quarterly t-stat > 2 |

**Don't shortcut steps 3-5.** Most "AI trading bot" YouTube channels skip the monkey test entirely — that's why they look impressive in tutorials and lose money live.

---

## 17. Dangerous Mistakes Cheatsheet

| Mistake | Consequence |
|---|---|
| Predicting absolute price | R²=0.99 looks great, learns nothing (just `price_t+1 ≈ price_t`) |
| Random shuffle on time series | Leaks via neighbor correlation |
| Fit scaler on full data | Silent look-ahead |
| Adjusted close from Yahoo | Future-info leak via splits/dividends |
| Compare to SPY only | Skips monkey test, can't distinguish skill from luck |
| Full Kelly | Optimal sizing assumes known edge — yours is noisy. Quarter Kelly. |
| Tune on test set | Once you peek, contaminated. Walk-forward. |
| Overnight holds | Model wasn't trained for gap distribution |
| Live deploy after backtest passes | Need 2+ years live monkey-pass for statistical significance |
| Rebuild from scratch when drifting | Drift, retrain, monitor — don't rebuild |

---

## 18. Tie-in references

- Universe: `server/services/premarketScanner.js:11-119`
- Existing 18 signals: `server/services/tomorrowMovers.js:506-742`
- Score blend: `server/services/signalLearner.js:140-241`
- Backtest harness: `server/services/historicalBacktest.js`
- Position sizing: `server/services/tradeStats.js:91-97` (Kelly)
- Auto-trader filters: `server/services/autoTrader.js:154-422`
- Existing claudeBrain veto: `server/services/claudeBrain.js:219-281`

The LSTM is one more vote in this system, not a replacement.
