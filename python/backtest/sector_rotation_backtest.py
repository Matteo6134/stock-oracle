"""
Sector-Rotation Portfolio Backtest
==================================
Weekly-rebalanced basket backtest — closer to how the live bot actually trades
(multi-day holds, several positions) than historical_replay.py's one-name
open-to-close day trades.

Strategy under test:
  Every REBALANCE_DAYS trading days, using ONLY information available at the
  prior close (all signals lagged 1 day):
    1. Keep the liquid slice: price in [min,max], 20d avg dollar volume >= floor.
    2. Rank sectors by the mean 20d return of their liquid members.
    3. Within the top N_SECTORS sectors, take the N_NAMES highest 20d-return
       names (relative-strength leaders), equal weight.
    4. Hold until the next rebalance; subtract slippage per rebalance.

Baselines on the SAME liquid universe and window:
  - SPY buy-and-hold
  - Equal-weight whole-universe (the "market" of our universe)
  - Random-basket monkeys (same N total names, same rebalance days)

Run:
  python sector_rotation_backtest.py --start 2022-01-01
  python sector_rotation_backtest.py --start 2026-06-11   # the bot's drawdown window
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
ARCHIVE_FILE = HERE / "archive" / "ohlcv_daily.parquet"
SECTORS_FILE = HERE / "archive" / "sectors.json"
RESULTS_DIR = HERE / "replay_results"


def load_data(start: str, end: str | None) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, str]]:
    df = pd.read_parquet(ARCHIVE_FILE, columns=["symbol", "date", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    buf = pd.to_datetime(start) - pd.Timedelta(days=60)
    df = df[df["date"] >= buf]
    if end:
        df = df[df["date"] <= end]
    closes = df.pivot_table(index="date", columns="symbol", values="close").astype("float32")
    volumes = df.pivot_table(index="date", columns="symbol", values="volume").astype("float32")
    raw = json.loads(SECTORS_FILE.read_text(encoding="utf-8"))
    sector_map = {s: v["sector"] for s, v in raw.items() if v.get("sector") and v["sector"] != "Unknown"}
    return closes, volumes, sector_map


def run(start: str, end: str | None, n_sectors: int, n_names: int, rebalance_days: int,
        min_price: float, max_price: float, min_dollar_volume: float,
        slippage_pct: float, n_monkeys: int, seed: int, pick: str = "leader") -> dict:
    closes, volumes, sector_map = load_data(start, end)

    ret1d = closes.pct_change()                       # c2c daily returns
    mom20 = closes.pct_change(20)                     # 20d momentum
    adv20 = (closes * volumes).rolling(20).mean()     # 20d avg dollar volume
    sma20 = closes.rolling(20).mean()
    range5 = (closes.rolling(5).max() - closes.rolling(5).min()) / closes.rolling(5).mean()

    # Everything the strategy sees is lagged one day.
    mom20_lag = mom20.shift(1)
    adv20_lag = adv20.shift(1)
    close_lag = closes.shift(1)
    above_sma_lag = (closes > sma20).shift(1)
    range5_lag = range5.shift(1)

    dates = closes.index[closes.index >= pd.to_datetime(start)]
    rebal_set = set(dates[::rebalance_days])
    sectors = pd.Series(sector_map)

    total_names = n_sectors * n_names
    rng = np.random.default_rng(seed)

    strat_daily: list[float] = []
    monkey_daily = np.zeros((n_monkeys, len(dates)))
    ew_daily: list[float] = []
    picks_log: list[dict] = []

    holdings: list[str] = []
    monkey_holdings = [[] for _ in range(n_monkeys)]

    for i, date in enumerate(dates):
        if date in rebal_set:
            liquid = (
                (close_lag.loc[date] >= min_price) & (close_lag.loc[date] <= max_price)
                & (adv20_lag.loc[date] >= min_dollar_volume) & mom20_lag.loc[date].notna()
            )
            eligible = close_lag.columns[liquid.fillna(False)]
            eligible = [s for s in eligible if s in sector_map]
            if eligible:
                m = mom20_lag.loc[date, eligible]
                sec = pd.Series({s: sector_map[s] for s in eligible})
                sec_mom = m.groupby(sec).mean().nlargest(n_sectors)
                pool = [s for s in eligible if sector_map[s] in sec_mom.index]
                if pick == "leader":
                    holdings = list(m.loc[pool].nlargest(total_names).index)
                elif pick == "moderate":
                    # 60-85th momentum percentile: strong but not parabolic
                    ranked = m.loc[pool].sort_values()
                    lo, hi = int(len(ranked) * 0.60), int(len(ranked) * 0.85)
                    holdings = list(ranked.iloc[lo:hi].nlargest(total_names).index)
                elif pick == "compression":
                    # uptrend (above 20d SMA) + tightest 5d range = quiet coil, not a pump
                    up = [s for s in pool if bool(above_sma_lag.loc[date].get(s, False))]
                    r5 = range5_lag.loc[date, up].dropna() if up else pd.Series(dtype="float64")
                    holdings = list(r5.nsmallest(total_names).index)
                elif pick == "sector_ew":
                    holdings = pool  # own the whole top-sector slice, equal weight
                else:
                    raise ValueError(f"unknown pick method {pick}")
                picks_log.append({"date": str(date.date()), "sectors": list(sec_mom.index),
                                  "names": holdings})
                for k in range(n_monkeys):
                    monkey_holdings[k] = list(rng.choice(eligible, size=min(total_names, len(eligible)),
                                                         replace=False))
            # slippage charged on each rebalance (round trip across the basket)
            rebal_cost = slippage_pct / 100.0
        else:
            rebal_cost = 0.0

        day_ret = ret1d.loc[date]
        strat_daily.append(float(day_ret.loc[holdings].mean()) - rebal_cost if holdings else 0.0)
        ew_all = day_ret.dropna()
        ew_daily.append(float(ew_all.mean()) if len(ew_all) else 0.0)
        mk = np.array([day_ret.loc[h].mean() if h else 0.0 for h in monkey_holdings], dtype="float64")
        monkey_daily[:, i] = np.nan_to_num(mk) - rebal_cost

    def stats(rets: np.ndarray) -> dict:
        rets = np.nan_to_num(np.asarray(rets, dtype="float64"))
        cum = (1 + rets).cumprod()
        dd = float(((cum / np.maximum.accumulate(cum)) - 1).min() * 100)
        sharpe = float((rets.mean() / rets.std()) * np.sqrt(252)) if rets.std() else 0.0
        return {"total_return_pct": round((cum[-1] - 1) * 100, 2),
                "sharpe": round(sharpe, 2), "max_drawdown_pct": round(dd, 2),
                "win_rate_daily": round(float((rets > 0).mean()), 3)}

    strat = stats(np.array(strat_daily))
    ew = stats(np.array(ew_daily))
    monkey_tot = (1 + np.nan_to_num(monkey_daily)).prod(axis=1) - 1
    strat_pctile = float((monkey_tot * 100 < strat["total_return_pct"]).mean() * 100)

    spy = ret1d.get("SPY")
    spy_stats = stats(spy.loc[dates].values) if spy is not None else {"note": "SPY missing"}

    return {
        "window": {"start": str(dates[0].date()), "end": str(dates[-1].date()), "n_days": len(dates)},
        "params": {"pick": pick, "n_sectors": n_sectors, "n_names_per_sector": n_names,
                   "rebalance_days": rebalance_days, "min_dollar_volume": min_dollar_volume,
                   "slippage_pct_per_rebalance": slippage_pct},
        "sector_rotation": {**strat, "monkey_percentile": round(strat_pctile, 1)},
        "spy_benchmark": spy_stats,
        "equal_weight_universe": ew,
        "monkey": {"n": n_monkeys,
                   "median_total_return_pct": round(float(np.median(monkey_tot) * 100), 2),
                   "p25_pct": round(float(np.percentile(monkey_tot, 25) * 100), 2),
                   "p75_pct": round(float(np.percentile(monkey_tot, 75) * 100), 2)},
        "recent_picks": picks_log[-4:],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default=None)
    ap.add_argument("--n-sectors", type=int, default=3)
    ap.add_argument("--n-names", type=int, default=4, help="names per sector")
    ap.add_argument("--rebalance-days", type=int, default=5)
    ap.add_argument("--min-price", type=float, default=1.0)
    ap.add_argument("--max-price", type=float, default=400.0)
    ap.add_argument("--min-dollar-volume", type=float, default=20_000_000)
    ap.add_argument("--slippage-pct", type=float, default=0.10)
    ap.add_argument("--n-monkeys", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--pick", default="leader",
                    choices=["leader", "moderate", "compression", "sector_ew"])
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    result = run(args.start, args.end, args.n_sectors, args.n_names, args.rebalance_days,
                 args.min_price, args.max_price, args.min_dollar_volume,
                 args.slippage_pct, args.n_monkeys, args.seed, args.pick)
    print(json.dumps(result, indent=2))
    out = Path(args.out) if args.out else RESULTS_DIR / f"sector_rotation_{args.pick}_{args.start}.json"
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[sector-rotation] wrote {out}")


if __name__ == "__main__":
    main()
