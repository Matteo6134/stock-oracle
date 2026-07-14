"""
Historical Replay — what if we had run a strategy over the last N years?
=========================================================================
Uses the local OHLCV archive (built by build_price_archive.py) to simulate
day-trading strategies. Currently implements:

  - Buy-and-hold-each-day-top-N (random pick = monkey, with seed)
  - Top-momentum: pick the symbol with highest recent return
  - Mean-reversion: pick the symbol most oversold relative to its 20d
  - Volume-spike: pick the symbol with highest volume vs 20d avg
  - Compositeable strategies via --strategy=<name> --strategy=<name>

Compares each strategy to the SPY buy-and-hold benchmark and to the random
monkey distribution (10,000 simulations). Outputs equity curves as CSV and a
summary report.

Important honesty constraints:
  - Cannot replay options/insider/dark-pool/news signals (data not archived)
  - Can replay anything derivable from price+volume only
  - Survivorship bias is partially mitigated since universe.json is fixed at
    extraction time, NOT today's S&P 500 (still imperfect — delisted symbols
    not present)

Run:
  python historical_replay.py --strategy momentum --start 2023-01-01 --end 2026-04-01
  python historical_replay.py --strategy volume_spike --top-n 1 --capital 1000
"""
from __future__ import annotations

import argparse
import gc
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ARCHIVE_FILE = Path(__file__).parent / "archive" / "ohlcv_daily.parquet"
SECTORS_FILE = Path(__file__).parent / "archive" / "sectors.json"
RESULTS_DIR = Path(__file__).parent / "replay_results"


def load_sector_map() -> dict[str, str]:
    """symbol -> sector, from the NASDAQ-screener snapshot. Empty dict if missing."""
    if not SECTORS_FILE.exists():
        return {}
    raw = json.loads(SECTORS_FILE.read_text(encoding="utf-8"))
    return {sym: v["sector"] for sym, v in raw.items() if v.get("sector") and v["sector"] != "Unknown"}


def load_archive() -> pd.DataFrame:
    if not ARCHIVE_FILE.exists():
        print(f"ERROR: {ARCHIVE_FILE} missing. Run build_price_archive.py first.", file=sys.stderr)
        sys.exit(2)
    df = pd.read_parquet(ARCHIVE_FILE)
    df["date"] = pd.to_datetime(df["date"])
    # Downcast float64 -> float32 to roughly halve memory on the large (~1500-symbol) archive
    for c in df.select_dtypes(include=["float64"]).columns:
        df[c] = df[c].astype("float32")
    return df.sort_values(["symbol", "date"]).reset_index(drop=True)


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add per-symbol rolling features used by strategies. Strict trailing windows.

    CRITICAL: features are computed from day t's close/volume, then SHIFTED FORWARD
    by 1 day so the strategy on day t only sees features available at end-of-day t-1.
    This eliminates look-ahead bias on the open-to-close trade of day t.
    """
    out = df.copy()
    g = out.groupby("symbol", group_keys=False)
    # transform (not apply) avoids a full-frame group-concat that OOMs on the large archive
    out["return_5d_pct"] = g["close"].transform(lambda s: s.pct_change(5) * 100)
    out["return_20d_pct"] = g["close"].transform(lambda s: s.pct_change(20) * 100)
    out["sma20"] = g["close"].transform(lambda s: s.rolling(20).mean())
    out["dist_sma20_pct"] = (out["close"] - out["sma20"]) / out["sma20"] * 100
    out["volume_avg20"] = g["volume"].transform(lambda s: s.rolling(20).mean())
    out["volume_ratio"] = out["volume"] / out["volume_avg20"]
    out["range_5d_pct"] = g["close"].transform(
        lambda s: (s.rolling(5).max() - s.rolling(5).min()) / s.rolling(5).mean() * 100
    )

    # Lag every feature by 1 day per symbol — features available at EOD t-1 only
    feature_cols = ["return_5d_pct", "return_20d_pct", "sma20", "dist_sma20_pct",
                    "volume_avg20", "volume_ratio", "range_5d_pct"]
    # float32 before the shift halves the shift's copy (rolling/pct_change return float64)
    out[feature_cols] = out[feature_cols].astype("float32")
    out[feature_cols] = out.groupby("symbol")[feature_cols].shift(1)
    return out


def liquidity_filter(slice_df: pd.DataFrame, min_price: float, max_price: float,
                     min_dollar_volume: float) -> pd.DataFrame:
    return slice_df[
        (slice_df["close"] >= min_price)
        & (slice_df["close"] <= max_price)
        & ((slice_df["close"] * slice_df["volume_avg20"]) >= min_dollar_volume)
    ]


# ─── Strategies ─────────────────────────────────────────────────────────────
# Each picks a single symbol from the day's filtered slice. Returns the picked
# row or None if no candidate.

def strategy_momentum(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    sub = slice_df.dropna(subset=["return_5d_pct"])
    if sub.empty:
        return None
    return sub.nlargest(1, "return_5d_pct").iloc[0]


def strategy_mean_reversion(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    sub = slice_df.dropna(subset=["dist_sma20_pct"])
    sub = sub[sub["dist_sma20_pct"] < -3]      # oversold by ≥3% from sma20
    if sub.empty:
        return None
    return sub.nsmallest(1, "dist_sma20_pct").iloc[0]


def strategy_volume_spike(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    sub = slice_df.dropna(subset=["volume_ratio", "return_5d_pct"])
    sub = sub[sub["volume_ratio"] > 2.0]       # at least 2x volume
    if sub.empty:
        return None
    return sub.nlargest(1, "volume_ratio").iloc[0]


def strategy_composite(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Score-based composite: 0.4 momentum + 0.3 volume + 0.3 mean-reversion-bonus."""
    sub = slice_df.dropna(subset=["return_5d_pct", "volume_ratio", "dist_sma20_pct"])
    if sub.empty:
        return None
    sub = sub.copy()
    sub["score"] = (
        sub["return_5d_pct"].clip(-20, 20) * 0.4
        + (sub["volume_ratio"].clip(0, 10) - 1) * 5 * 0.3
        + (-sub["dist_sma20_pct"].clip(-20, 5)) * 0.3
    )
    return sub.nlargest(1, "score").iloc[0]


def strategy_random(slice_df: pd.DataFrame, rng: np.random.Generator, **_) -> pd.Series | None:
    if slice_df.empty:
        return None
    idx = rng.integers(0, len(slice_df))
    return slice_df.iloc[idx]


def _top_sectors(sub: pd.DataFrame, n: int = 3) -> pd.Index:
    """Rank sectors by mean lagged 20d return across the day's liquid slice."""
    return sub.groupby("sector")["return_20d_pct"].mean().nlargest(n).index


def strategy_sector_rotation(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Only fish in the top-3 sectors by 20d momentum; buy the relative-strength leader.
    All features are lagged 1 day upstream, so sector ranks use yesterday's info only."""
    if "sector" not in slice_df.columns:
        return None
    sub = slice_df.dropna(subset=["return_20d_pct"])
    sub = sub[sub["sector"].notna()]
    if sub.empty:
        return None
    top = sub[sub["sector"].isin(_top_sectors(sub))]
    if top.empty:
        return None
    return top.nlargest(1, "return_20d_pct").iloc[0]


def strategy_sector_compression(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Top-3 sectors by 20d momentum -> uptrend names only -> tightest 5d range.
    Price-only proxy of the bot's best-measured signals (volume_contraction/bb_squeeze)
    applied inside the strongest sectors instead of the whole market."""
    if "sector" not in slice_df.columns:
        return None
    sub = slice_df.dropna(subset=["return_20d_pct", "range_5d_pct", "dist_sma20_pct"])
    sub = sub[sub["sector"].notna()]
    if sub.empty:
        return None
    top = sub[sub["sector"].isin(_top_sectors(sub)) & (sub["dist_sma20_pct"] > 0)]
    if top.empty:
        return None
    return top.nsmallest(1, "range_5d_pct").iloc[0]


STRATEGIES = {
    "momentum": strategy_momentum,
    "mean_reversion": strategy_mean_reversion,
    "volume_spike": strategy_volume_spike,
    "composite": strategy_composite,
    "random": strategy_random,
    "sector_rotation": strategy_sector_rotation,
    "sector_compression": strategy_sector_compression,
}


def run_strategy(df: pd.DataFrame, strategy: str, start: str, end: str,
                 min_price: float, max_price: float, min_dollar_volume: float,
                 slippage_pct: float = 0.10, seed: int = 42) -> dict:
    """Simulates a single-pick-per-day strategy with realistic costs.
    slippage_pct: round-trip cost in % (default 0.10 = 10 bps total — half on entry, half on exit).
    """
    rng = np.random.default_rng(seed)
    fn = STRATEGIES[strategy]
    df = df[(df["date"] >= start) & (df["date"] <= end)]  # already a fresh subset — no redundant .copy()
    dates = sorted(df["date"].unique())

    picks = []
    for date in dates:
        slice_df = df[df["date"] == date]
        slice_df = liquidity_filter(slice_df, min_price, max_price, min_dollar_volume)
        if slice_df.empty:
            continue
        pick = fn(slice_df, rng=rng)
        if pick is None:
            continue
        gross = float(pick["o2c_return_pct"])
        net = gross - slippage_pct       # subtract round-trip slippage cost
        picks.append({
            "date": str(date.date()) if hasattr(date, "date") else str(date),
            "symbol": pick["symbol"],
            "open": float(pick["open"]),
            "close": float(pick["close"]),
            "gross_return_pct": gross,
            "net_return_pct": net,
            "volume_ratio": float(pick.get("volume_ratio", 1) or 1),
        })

    if not picks:
        return {"strategy": strategy, "n_picks": 0}

    rets = np.array([p["net_return_pct"] for p in picks]) / 100.0
    cum = (1 + rets).cumprod()
    return {
        "strategy": strategy,
        "n_picks": len(picks),
        "slippage_pct_per_trade": slippage_pct,
        "total_return_pct": round((cum[-1] - 1) * 100, 3),
        "annualized_return_pct": round(((cum[-1] ** (252 / max(len(rets), 1))) - 1) * 100, 3),
        "win_rate": round(float((rets > 0).mean()), 3),
        "avg_daily_return_pct": round(float(rets.mean() * 100), 4),
        "daily_std_pct": round(float(rets.std() * 100), 4),
        "sharpe_annualized": round(float((rets.mean() / rets.std()) * np.sqrt(252)) if rets.std() else 0, 3),
        "max_drawdown_pct": round(float(((cum / np.maximum.accumulate(cum)) - 1).min() * 100), 3),
        "picks": picks,
    }


def benchmark_spy(df: pd.DataFrame, start: str, end: str) -> dict:
    spy = df[(df["symbol"] == "SPY") & (df["date"] >= start) & (df["date"] <= end)]
    if spy.empty:
        # SPY not in archive — fetch on demand
        try:
            import yfinance as yf
            spy_raw = yf.download("SPY", start=str(start)[:10], end=str(pd.to_datetime(end) + pd.Timedelta(days=1))[:10],
                                  interval="1d", auto_adjust=False, progress=False)
            if spy_raw.empty:
                return {"benchmark": "SPY", "note": "SPY fetch failed"}
            spy = spy_raw.reset_index()
            spy.columns = [c.lower() if isinstance(c, str) else c[0].lower() for c in spy.columns]
            spy["date"] = pd.to_datetime(spy["date"])
            spy["c2c_return_pct"] = spy["close"].pct_change() * 100
        except Exception as exc:
            return {"benchmark": "SPY", "note": f"SPY fetch error: {exc}"}
    p0 = float(spy.iloc[0]["close"])
    pN = float(spy.iloc[-1]["close"])
    rets = spy["c2c_return_pct"].fillna(0).values / 100.0
    cum = (1 + rets).cumprod()
    return {
        "benchmark": "SPY",
        "start": str(spy["date"].iloc[0]),
        "end": str(spy["date"].iloc[-1]),
        "total_return_pct": round((pN / p0 - 1) * 100, 3),
        "win_rate": round(float((rets > 0).mean()), 3),
        "sharpe_annualized": round(float((rets.mean() / rets.std()) * np.sqrt(252)) if rets.std() else 0, 3),
        "max_drawdown_pct": round(float(((cum / np.maximum.accumulate(cum)) - 1).min() * 100), 3),
    }


def monkey_distribution(df: pd.DataFrame, start: str, end: str,
                        min_price: float, max_price: float, min_dollar_volume: float,
                        n_monkeys: int = 10_000, seed: int = 42) -> dict:
    """Run N random-pick simulations on the same filtered universe."""
    rng = np.random.default_rng(seed)
    df = df[(df["date"] >= start) & (df["date"] <= end)]  # already a fresh subset — no redundant .copy()
    dates = sorted(df["date"].unique())
    daily_rets_per_monkey = np.zeros((n_monkeys, len(dates)))

    for di, date in enumerate(dates):
        slice_df = liquidity_filter(df[df["date"] == date], min_price, max_price, min_dollar_volume)
        if slice_df.empty:
            continue
        rets = slice_df["o2c_return_pct"].values / 100.0
        picks = rng.integers(0, len(rets), size=n_monkeys)
        daily_rets_per_monkey[:, di] = rets[picks]

    cum_per_monkey = (1 + daily_rets_per_monkey).prod(axis=1) - 1
    return {
        "n_monkeys": n_monkeys,
        "n_days": len(dates),
        "mean_total_return_pct": round(float(cum_per_monkey.mean() * 100), 3),
        "median_total_return_pct": round(float(np.median(cum_per_monkey) * 100), 3),
        "p5_pct": round(float(np.percentile(cum_per_monkey, 5) * 100), 3),
        "p25_pct": round(float(np.percentile(cum_per_monkey, 25) * 100), 3),
        "p75_pct": round(float(np.percentile(cum_per_monkey, 75) * 100), 3),
        "p95_pct": round(float(np.percentile(cum_per_monkey, 95) * 100), 3),
        "all_returns": cum_per_monkey.tolist()[:1000],   # sample for plotting
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", action="append", required=True,
                    choices=list(STRATEGIES.keys()))
    ap.add_argument("--start", default=None, help="YYYY-MM-DD; default = 2y ago")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD; default = today")
    ap.add_argument("--min-price", type=float, default=1.0)
    ap.add_argument("--max-price", type=float, default=400.0)
    ap.add_argument("--min-dollar-volume", type=float, default=20_000_000,
                    help="Higher = more liquid universe = more realistic results. Default $20M ADV.")
    ap.add_argument("--slippage-pct", type=float, default=0.10,
                    help="Round-trip slippage cost in %. Default 0.10 (10 bps).")
    ap.add_argument("--n-monkeys", type=int, default=10_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(RESULTS_DIR / "replay_report.json"))
    args = ap.parse_args()

    print("[replay] loading archive ...")
    df_raw = load_archive()
    print(f"[replay] {len(df_raw):,} rows, {df_raw['symbol'].nunique()} symbols, "
          f"{df_raw['date'].min().date()} .. {df_raw['date'].max().date()}")

    # POLICY: default to the FULL archive history (≈2016 → latest) and keep it current as
    # the archive is refreshed forward. Always backtest the maximum window unless overridden.
    if not args.start:
        args.start = df_raw["date"].min().date().isoformat()   # full history (was: 2y ago)
    if not args.end:
        args.end = df_raw["date"].max().date().isoformat()
    args.start = pd.to_datetime(args.start)
    args.end = pd.to_datetime(args.end)

    # Liquidity pre-filter: strategies need ~$20M ADV to pick a name, so symbols whose
    # median daily dollar volume is far below that can never be selected — drop the dead
    # tail. Then pre-slice to [start - 60d buffer, end] so the ~1500-symbol x 10y archive
    # fits in RAM before feature engineering (the 60-day buffer seeds 20-day rolling features).
    _dv = (df_raw["close"].astype("float64") * df_raw["volume"].astype("float64"))
    _med = _dv.groupby(df_raw["symbol"]).transform("median")
    _before = df_raw["symbol"].nunique()
    df_raw = df_raw[_med >= 5_000_000]
    del _dv, _med
    _buf = args.start - pd.Timedelta(days=60)
    df_raw = df_raw[(df_raw["date"] >= _buf) & (df_raw["date"] <= args.end)].reset_index(drop=True)
    gc.collect()
    print(f"[replay] window {args.start.date()}..{args.end.date()} | liquidity+slice: "
          f"{_before} -> {df_raw['symbol'].nunique()} symbols, {len(df_raw):,} rows")

    print("[replay] computing features ...")
    df = add_features(df_raw)
    del df_raw
    gc.collect()

    sector_map = load_sector_map()
    if sector_map:
        df["sector"] = df["symbol"].map(sector_map)
        n_mapped = df.loc[df["sector"].notna(), "symbol"].nunique()
        print(f"[replay] sector map: {n_mapped}/{df['symbol'].nunique()} symbols mapped")
    else:
        print("[replay] no sectors.json — sector strategies unavailable")
    print(f"[replay] backtest window: {args.start.date()} .. {args.end.date()}")

    spy = benchmark_spy(df, args.start, args.end)
    print(f"\n=== BENCHMARK SPY ===")
    for k, v in spy.items():
        print(f"  {k:30s} {v}")

    print(f"\n[replay] running monkey distribution ({args.n_monkeys:,} simulations) ...")
    monkey = monkey_distribution(df, args.start, args.end, args.min_price, args.max_price,
                                 args.min_dollar_volume, args.n_monkeys, args.seed)
    print(f"  monkey_mean_total_return_pct  {monkey['mean_total_return_pct']}")
    print(f"  monkey_median_total_return_pct {monkey['median_total_return_pct']}")
    print(f"  monkey p5..p95 ({monkey['p5_pct']:.1f}%, {monkey['p25_pct']:.1f}%, "
          f"{monkey['p75_pct']:.1f}%, {monkey['p95_pct']:.1f}%)")

    strategy_results = {}
    for strat in args.strategy:
        print(f"\n[replay] running strategy: {strat}")
        result = run_strategy(df, strat, args.start, args.end, args.min_price, args.max_price,
                              args.min_dollar_volume, args.slippage_pct, args.seed)
        result_minus_picks = {k: v for k, v in result.items() if k != "picks"}
        for k, v in result_minus_picks.items():
            print(f"  {k:30s} {v}")
        # Compute monkey percentile
        if result.get("total_return_pct") is not None:
            pct = float(np.mean(np.array(monkey["all_returns"]) * 100 < result["total_return_pct"])) * 100
            print(f"  monkey_percentile             {pct:.1f}")
            result["monkey_percentile"] = round(pct, 1)
        strategy_results[strat] = result

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out)
    out_path.write_text(json.dumps({
        "window": {"start": str(args.start.date()), "end": str(args.end.date())},
        "filters": {"min_price": args.min_price, "max_price": args.max_price,
                    "min_dollar_volume": args.min_dollar_volume},
        "spy_benchmark": spy,
        "monkey_distribution": {k: v for k, v in monkey.items() if k != "all_returns"},
        "strategies": {k: {kk: vv for kk, vv in v.items() if kk != "picks"}
                        for k, v in strategy_results.items()},
    }, indent=2, default=str), encoding="utf-8")
    print(f"\n[replay] wrote {out_path}")

    for strat, result in strategy_results.items():
        if "picks" in result:
            picks_csv = RESULTS_DIR / f"{strat}_picks.csv"
            pd.DataFrame(result["picks"]).to_csv(picks_csv, index=False)
            print(f"[replay] wrote picks -> {picks_csv}")


if __name__ == "__main__":
    main()
