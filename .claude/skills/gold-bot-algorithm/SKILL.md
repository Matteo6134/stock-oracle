---
name: gold-bot-algorithm
description: Reference for HOW the alpaca-gold-bot Python scalper at C:/Users/pc2/Desktop/gold works — 3-push exhaustion + absorption pattern on 1-min Nasdaq bars, ATR-based bracket orders, BE/2R-trail state machine. Use when developing v2/v3, debugging entry/exit logic, tuning scalper thresholds, wiring the dead news filter, or proposing strategy changes. Triggers: "gold bot algorithm", "scalper", "valentini", "absorption", "3 push", "v2 gold", "scalper rewrite", "alpaca python bot logic".
---

# Alpaca Gold Bot — Ground Truth Reference

> Path: `C:/Users/pc2/Desktop/gold/` — files: `alpaca_gold_bot.py` (493 lines), `config.py` (44), `news_filter.py` (91).
> All citations: `alpaca_gold_bot.py:LINE` unless otherwise noted.

## Identity vs name

The repo is named "gold" but the live config trades **Nasdaq tech equities**, not metals. The README is a stub ("# GOLD"). Trader DNA: a "Valentini scalper" / "Fabio Nasdaq setup" using a 3-push exhaustion + absorption pattern on 1-minute bars. Italian comments throughout. **If you rename for v2, propose `alpaca-nasdaq-scalper`.**

---

## 1. Universe (`config.py:15`)

```python
SYMBOLS = ['QQQ', 'TQQQ', 'SQQQ', 'NVDA', 'TSLA']
```

5 Nasdaq-correlated names: index ETF + 3× leveraged long/short + two mega-cap tech. **No GLD/SLV/LIT** despite repo name.

Auxiliary tickers used by code:
- `VIX_SYMBOL = 'VXX'` (`config.py:33`) — **misnamed**, fetches VXX (VIX futures ETN), not ^VIX index
- `UUP_SYMBOL` referenced at `:213` but **NOT defined in config.py** → would crash if `DXY_FILTER_ENABLED=True`. Safe only because flag defaults False.

---

## 2. Indicators (`get_market_data` `:108-145`)

Built from **1-min bars over 3-day lookback** (`:113`).

| Indicator | Call | Params | Constant |
|---|---|---|---|
| RSI | `ta.rsi(close, length=RSI_PERIOD)` `:119` | length=5 | `RSI_PERIOD=5` config:21 |
| Bollinger | `ta.bbands(close, length=20, std=2.5)` `:120` | 20, 2.5 | config:22-23 |
| ATR | `ta.atr(h, l, c, length=10)` `:129` | length=10 **hardcoded** | n/a |
| VWAP | manual: `(tp×vol).cumsum() / vol.cumsum()` `:125-126` | session running | `VWAP_PERIOD=1` config:24 **NOT USED** |
| Volume MA | `volume.rolling(20).mean()` `:130` | window=20 hardcoded | n/a |
| Volume Profile | `pd.cut` 20 bins on last 100 bars `:134-143` | bins=20, lookback=100 | hardcoded |

POC = midpoint of bin with max summed volume (`:138-139`). VAL/VAH approximated as 15th/85th percentile of close over last 100 bars (`:142-143`) — **not a true value-area calc**, just price quantiles.

**RSI/BB/VWAP are computed but only RSI is read** (and only inside dead `is_dollar_too_strong`). Live entry logic uses **only ATR, Volume MA, VAL/VAH, raw OHLC**.

---

## 3. Entry — "Trap" Pattern (`check_signals` `:147-205`)

### Bar features (`:157-168`)
```python
body_size   = abs(close - open)
total_range = high - low (or 0.001)
upper_wick  = high - max(open, close)
lower_wick  = min(open, close) - low
```

### Three absorption sub-filters (`:179-187`)
```python
is_effort_stalled  = vol > vol_ma * 1.5  AND  body_size < total_range * 0.3
is_buy_rejection   = vol > vol_ma * 1.3  AND  lower_wick > total_range * 0.6
is_sell_rejection  = vol > vol_ma * 1.3  AND  upper_wick > total_range * 0.6
is_vol_cluster     = vol[-1] > vol[-2] > vol[-3]
```

`ABSORPTION_VOL_MULT=1.5` defined in config but the 1.5 / 1.3 multipliers are **hardcoded inline** — config value is unused.

### BUY trigger (`:190-195`)
```python
is_3_push_down  = all 3 of bars[-4:-1] are red (close < open)
absorption_buy  = is_effort_stalled or is_buy_rejection or (is_vol_cluster and price < val)

if is_3_push_down  AND  absorption_buy
                   AND  price < val
                   AND  current_close > prev_high:
    return "BUY", price, atr
```

In English: 3 consecutive red bars + any absorption pattern + close below value-area-low + current close breaks above the previous bar's high (rejection-of-low confirmation).

`MOMENTUM_PUSHES=3` defined but the count `3` is hardcoded via `df.iloc[-4:-1]`.

### SELL trigger (`:198-203`) — symmetric
```python
is_3_push_up    = all 3 of bars[-4:-1] are green
absorption_sell = is_effort_stalled or is_sell_rejection or (is_vol_cluster and price > vah)

if is_3_push_up  AND  absorption_sell
                 AND  price > vah
                 AND  current_close < prev_low:
    return "SELL", price, atr
```

### Pre-trade gates (in main loop)
1. **Drawdown** — `check_drawdown` `:99-106`. Halts entire run if `account.equity < DRAWDOWN_LIMIT (1000.0)` config:18.
2. **VIX/VXX panic** — `is_volatility_too_high` `:241-253`. Returns True if `VXX close > VIX_THRESHOLD (80.0)` config:34. **Practically unreachable** (VXX trades 10-30 typically).
3. **PDT** — see §6.
4. **Slot capacity** — see §7.
5. **News** — `NewsFilter` instantiated `:47` but **`check_news_event()` is never called**. Dead integration.

---

## 4. Position Sizing (`execute_trade` `:287-336`)

```python
sl_dist  = atr * STOP_LOSS_ATR_MULT                     # =1.2 (config:36)
qty      = round(FIXED_RISK_DOLLARS / sl_dist, 2)       # =$20 (config:16)
notional = qty * current_price
if notional > buying_power * 0.9:
    qty = round((buying_power * 0.8) / current_price, 2)   # fallback
if notional < 1.0: return None                          # too small to bother
```

**Formula**: `qty = $20 / (ATR × 1.2)`. Fractional shares (2-decimal). Alpaca supports fractional on these tickers.

**Bracket order** (single `MarketOrderRequest` `:321-329`):
- SL: `entry ± sl_dist`
- TP: `entry ± (sl_dist × SCALPER_TARGET_RATIO)` where ratio=4.0 (config:29) → **4R take-profit**

---

## 5. Position State Machine (`manage_positions` `:337-384`)

Runs every loop iteration BEFORE scanning new entries (`:440`). Iterates `get_all_positions()`:

### State A — `BE_SECURED` (`:353-360`)
**Trigger**: `unrealized_plpc ≥ MOVE_TO_BE_PROFIT_PCT (0.003 = +0.30%)` config:30.
**Action**: cancel protective orders, submit fresh stop at entry price (break-even). Idempotent guard at `:355` skips if BE stop already exists.
Logged: `"BE_SECURED"` reason `"Profit +X.XX%"`.

### State B — `VALENTINI SCALING` (`:363-371`)
**Trigger**: `plpc ≥ +1%` AND `buying_power > 500`.
**THIS IS A NO-OP**: function body is `pass`. Only logs intent — doesn't add to position. Implement or remove in v2.

### State C — `PROFIT_SECURED` (`:374-381`)
**Trigger**: `plpc ≥ 0.01 × SCALPER_TARGET_RATIO / 2` = `0.01 × 4 / 2` = **+2% (i.e. 2R)**.
**Action**: move stop to `entry × 1.01` (locks +1% / 1R).
Logged: `"PROFIT_SECURED"` reason `"Hit 2R target"`.

### Lifecycle
```
NEW (bracket: SL @ entry-1.2×ATR, TP @ entry+4.8×ATR)
  └─ +0.30% → BE_SECURED   (SL → entry; TP cancelled)
       └─ +1.00% → [SCALING logged, no-op]
            └─ +2.00% → PROFIT_SECURED (SL → entry+1%)
                 └─ exit by stop hit (no TP remaining)
```

### Bug — PROFIT_SECURED unguarded
`manage_positions` runs every 5 sec. Once plpc≥2%, State C fires every loop — `_update_stop_order` cancels ALL open orders (including original 4R TP) and resubmits the stop. **Original 4R TP is destroyed after first PROFIT_SECURED**, so exits only via the trailing 1R stop. v2 must add an "already trailed" flag.

---

## 6. PDT Handling (`check_pdt_rule` `:223-239`)

```python
if equity >= 25000:        return True            # PDT exempt
if daytrade_count >= 3:
    log "PDT RULE ALERT: ... 3 Day Trades ..."
    return False                                  # block new entries
return True
```

Called once per loop (`:449`). False → entire entry block skipped, existing positions still managed.

---

## 7. Main Loop (`run` `:429-475`)

```python
while True:
    if not check_drawdown(): break
    manage_positions()                            # exits / BE / profit-secure first
    busy = {p.symbol for positions} | {o.symbol for open_orders}
    slots = MAX_POSITIONS - len(busy)             # MAX=5

    if slots > 0 and check_pdt_rule():
        opps = get_all_opportunities()            # scan all 5 symbols
        for opp in opps:
            if trades_placed >= slots: break
            if opp.symbol in busy: continue
            order = execute_trade(opp.symbol, opp.side, opp.atr)
            if order: busy.add(...); trades_placed += 1

    time.sleep(SCAN_INTERVAL)                     # =5 sec
```

- Cadence: **5 seconds** (config:39)
- Slots: 5 (config:17) = symbol count → tries to be in every name simultaneously
- "Busy" = open position OR pending order on that symbol — prevents double-entry
- **No ranking/scoring** — `get_all_opportunities` `:255-280` iterates SYMBOLS in declaration order, returns all valid signals
- Uncaught exception → sleep 30s and retry (`:473-475`)

---

## 8. News Filter (`news_filter.py`)

- **Source**: ForexFactory free XML — `https://nfs.faireconomy.media/ff_calendar_thisweek.xml` (`:12`)
- **Refresh**: max once per hour (`:22`)
- **Filter**: country=USD AND impact=High (`:42`). Skips empty/"All Day"/"Tentative" times (`:52`)
- **Time parse**: `MM-DD-YYYY HH:MMam/pm` → America/New_York → UTC (`:59-61`)
- **Block window**: True if any qualifying event within ±15 minutes (900s) of `now_utc` (`:86`)

**Critical gap**: instantiated as `self.news` (`:47`) but `self.news.check_news_event()` is **never called**. **v2 must wire it into the pre-entry gate** alongside drawdown / VIX / PDT.

---

## 9. Supabase Logging (`log_trade_action` `:67-97`)

Initialised from SUPABASE_URL / SUPABASE_ANON_KEY (config:11-12). Graceful degrade when missing (warning + `self.supabase=None`).

**Local**: appends row to `trades_history.csv` (`Timestamp,Symbol,Action,Amount/Qty,Price,Reason`) (`:64,72-74`).

**Cloud**: single table `market_trade` (`:93`). Schema:
```python
{
  "symbol":      symbol,
  "side":        "buy" if "BUY" in action else "sell",
  "qty":         float(qty),
  "entry_price": price if "ENTRY" in action else None,
  "exit_price":  price if action ∈ EXIT/PROFIT/BE else None,
  "exit_reason": reason if action ∈ EXIT/PROFIT/BE else None,
  "signals":     [action]
}
```

Action strings emitted:
- `"ENTRY_OrderSide.BUY"` / `"ENTRY_OrderSide.SELL"` (`:332`) — enum interpolated as string; v2 use `side.value`
- `"BE_SECURED"` (`:360`)
- `"PROFIT_SECURED"` (`:380`)

**No EXIT row written**. SL/TP fills at Alpaca side don't trigger logging → realised P&L invisible to Supabase.

---

## 10. Constants Cheatsheet (`config.py`)

```
SYMBOLS                = ['QQQ','TQQQ','SQQQ','NVDA','TSLA']  :15
FIXED_RISK_DOLLARS     = 20.0       :16   $ risk per trade
MAX_POSITIONS          = 5          :17   concurrent slots = symbol count
DRAWDOWN_LIMIT         = 1000.0     :18   halt-all equity floor

RSI_PERIOD             = 5          :21   used (in dead code)
BB_PERIOD              = 20         :22
BB_STD                 = 2.5        :23
VWAP_PERIOD            = 1          :24   DEFINED, NOT USED

MOMENTUM_PUSHES        = 3          :27   DEFINED, hardcoded as 3 inline
ABSORPTION_VOL_MULT    = 1.5        :28   DEFINED, NOT USED (1.5/1.3 hardcoded)
SCALPER_TARGET_RATIO   = 4.0        :29   TP = 4R
MOVE_TO_BE_PROFIT_PCT  = 0.003      :30   +0.3% triggers BE

VIX_SYMBOL             = 'VXX'      :33   misnomer (it's VXX not ^VIX)
VIX_THRESHOLD          = 80.0       :34   practically unreachable
DXY_FILTER_ENABLED     = False      :35   dead code
STOP_LOSS_ATR_MULT     = 1.2        :36   SL distance multiplier

SCAN_INTERVAL          = 5          :39   seconds
CANDLE_TIMEFRAME       = 1          :40   1-min bars
```

---

## 11. Known Issues / Dead Code (the v2 punch list)

1. **News filter never called** (`:47`) — `NewsFilter` instantiated, `check_news_event()` never invoked. **HIGH priority** wire-in for v2.
2. **VWAP_PERIOD, ABSORPTION_VOL_MULT, MOMENTUM_PUSHES** defined but ignored; magic numbers hardcoded.
3. **VIX_THRESHOLD=80 on VXX** — never triggers. Either lower or switch to ^VIX index data.
4. **`is_dollar_too_strong`** (`:208-221`) — references undefined `config.UUP_SYMBOL` / `DXY_THRESHOLD`. Safe only because `DXY_FILTER_ENABLED=False`.
5. **VALENTINI SCALING is a `pass`** (`:363-371`) — pure log noise. Implement or remove.
6. **PROFIT_SECURED runs every loop** (`:374-381`) — destroys the original 4R TP after first trigger. Add `already_trailed` flag.
7. **`"ENTRY_OrderSide.BUY"`** action string (`:332`) — enum interpolated as object. Use `side.value`.
8. **No EXIT row in Supabase** — closed-trade P&L invisible to cloud. Hook position-close detection.
9. **README is stub** ("# GOLD" only).
10. **Logger double-emit** in `log_trade_action` (`:96-97`).
11. **Repo name vs universe mismatch** — repo "gold", trades QQQ/TQQQ/SQQQ/NVDA/TSLA. Either rename or restore gold tickers.
12. **No ranking among opportunities** — first-come-first-served fills slots. v2: rank by ATR/volatility or absorption strength.
13. **Single timeframe** — only 1-min bars. v2: confirm with 5-min trend.

---

## 12. Architectural notes for v2/v3

- **State persistence**: bot keeps no internal state across restarts — relies entirely on Alpaca position queries + open orders to reconstruct. Pro: simple. Con: an "already trailed" flag (issue #6) needs *some* state — could store in Supabase or `state.json`.
- **Single-thread polling loop** — fine at 5s for 5 symbols. v2 with more symbols should consider asyncio or per-symbol threads.
- **Bracket order race**: between `get_all_positions()` and `submit_order(bracket)` a fill can occur on a related order. Currently no idempotency key — consider Alpaca client_order_id derived from `f"{symbol}-{ts}-{side}"`.
- **No backtesting harness** — strategy is live-tested on paper account. v2 should add historical replay (the absorption pattern is testable on bar-level data).
- **News filter wiring** is the cheapest, highest-impact v2 fix — already fully implemented in `news_filter.py`, just needs one line in the pre-entry gate.

---

## 13. File map

```
C:/Users/pc2/Desktop/gold/alpaca_gold_bot.py    main loop (493 lines)
C:/Users/pc2/Desktop/gold/config.py             constants (44 lines)
C:/Users/pc2/Desktop/gold/news_filter.py        ForexFactory news filter (91 lines, DEAD)
C:/Users/pc2/Desktop/gold/trades_history.csv    local trade log
C:/Users/pc2/Desktop/gold/alpaca_bot.log        runtime log
```

PM2-managed. Logs: `C:/Users/pc2/Desktop/gold/logs/{out,error}.log`. Restart: `pm2 restart alpaca-gold-bot`.
