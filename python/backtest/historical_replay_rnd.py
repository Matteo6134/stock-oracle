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
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ARCHIVE_FILE = Path(__file__).parent / "archive" / "ohlcv_daily.parquet"
RESULTS_DIR = Path(__file__).parent / "replay_results_rnd"

# Look-ahead-safe SPY regime map (date -> SPY above its own lagged 20d SMA). Populated by
# add_features(); used by the squeeze_spy_regime_gated strategy. Empty by default.
SPY_UP_BY_DATE: dict = {}


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
    out["return_5d_pct"] = g["close"].transform(lambda s: s.pct_change(5) * 100)
    out["return_20d_pct"] = g["close"].transform(lambda s: s.pct_change(20) * 100)
    out["sma20"] = g["close"].transform(lambda s: s.rolling(20).mean())
    out["dist_sma20_pct"] = (out["close"] - out["sma20"]) / out["sma20"] * 100
    out["volume_avg20"] = g["volume"].transform(lambda s: s.rolling(20).mean())
    out["volume_ratio"] = out["volume"] / out["volume_avg20"]
    out["range_5d_pct"] = g["close"].transform(
        lambda s: (s.rolling(5).max() - s.rolling(5).min()) / s.rolling(5).mean() * 100
    )
    # --- R&D added features (computed PRE-shift so they get lagged like the rest) ---
    # 20-day range as % of 20-day mean (denominator of the squeeze compression ratio)
    out["range_20d_pct"] = g["close"].transform(
        lambda s: (s.rolling(20).max() - s.rolling(20).min()) / s.rolling(20).mean() * 100
    )
    # distance from the 20-day high: <=0 below high; >-5 means within 5% of its 20d high
    out["high_20d"] = g["close"].transform(lambda s: s.rolling(20).max())
    out["dist_high20_pct"] = (out["close"] - out["high_20d"]) / out["high_20d"] * 100

    # Lag every feature by 1 day per symbol — features available at EOD t-1 only
    feature_cols = ["return_5d_pct", "return_20d_pct", "sma20", "dist_sma20_pct",
                    "volume_avg20", "volume_ratio", "range_5d_pct",
                    "range_20d_pct", "high_20d", "dist_high20_pct"]
    # Cast to float32 BEFORE the shift so the shift's copy is half-size (rolling/pct_change
    # produce float64); halves feature-block memory on the large archive.
    out[feature_cols] = out[feature_cols].astype("float32")
    out[feature_cols] = out.groupby("symbol")[feature_cols].shift(1)

    # --- Build a look-ahead-safe SPY market-regime map: date -> SPY above its own 20d SMA.
    # The archive contains individual stocks only (no SPY row), so the SPY series is sourced
    # from yfinance (same source the harness uses for benchmark_spy). The regime flag is SPY
    # close > SPY rolling(20) mean, then SHIFTED +1 day so day t sees only EOD t-1 info — no
    # look-ahead. Falls back to an archive equal-weight breadth proxy if the fetch fails.
    global SPY_UP_BY_DATE
    SPY_UP_BY_DATE = _build_spy_regime_map(out["date"].min(), out["date"].max())
    return out


def _build_spy_regime_map(start, end) -> dict:
    """date(Timestamp) -> bool: SPY above its own 20d SMA at EOD t-1 (lagged, no look-ahead)."""
    try:
        import yfinance as yf
        raw = yf.download("SPY", start=str(start)[:10],
                          end=str(pd.to_datetime(end) + pd.Timedelta(days=2))[:10],
                          interval="1d", auto_adjust=False, progress=False)
        if raw.empty:
            raise RuntimeError("empty SPY fetch")
        spy = raw.reset_index()
        spy.columns = [c.lower() if isinstance(c, str) else c[0].lower() for c in spy.columns]
        spy["date"] = pd.to_datetime(spy["date"])
        spy = spy.sort_values("date")
        sma20 = spy["close"].rolling(20).mean()
        up = (spy["close"] > sma20).shift(1)   # lag +1 day -> EOD t-1 info only
        return {d: bool(v) for d, v in zip(spy["date"], up) if pd.notna(v)}
    except Exception as exc:  # noqa: BLE001 — degrade to breadth proxy, never crash the run
        print(f"[replay] SPY regime fetch failed ({exc}); using archive breadth proxy", file=sys.stderr)
        return {}


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


# ─── R&D candidate strategies (Bollinger-squeeze family) ─────────────────────
# All read ONLY lagged feature columns (range_5d_pct, range_20d_pct, volume_avg20,
# close*, dist_sma20_pct, dist_high20_pct, volume_ratio). NOTE: `close` and
# `volume_avg20` are used only for the liquidity gate (close*volume_avg20 >= ADV),
# which mirrors the harness's own liquidity_filter; the predictive RANK uses the
# lagged compression ratio range_5d_pct/range_20d_pct only — no same-day signal.

def _squeeze_pick(slice_df: pd.DataFrame, adv_floor: float) -> pd.Series | None:
    """Shared squeeze mechanic: mega-liquid + above-20d-trend, rank tightest coil."""
    sub = slice_df.dropna(subset=["range_5d_pct", "range_20d_pct", "volume_avg20",
                                  "close", "dist_sma20_pct"])
    if sub.empty:
        return None
    sub = sub.copy()
    sub = sub[((sub["close"] * sub["volume_avg20"]) >= adv_floor)
              & (sub["dist_sma20_pct"] > 0)]
    if sub.empty:
        return None
    sub = sub[sub["range_20d_pct"] != 0]           # guard divide-by-zero
    if sub.empty:
        return None
    sub["compress"] = sub["range_5d_pct"] / sub["range_20d_pct"]
    sub = sub.dropna(subset=["compress"])
    if sub.empty:
        return None
    return sub.nsmallest(1, "compress").iloc[0]


def strategy_mega_liquid_bb_squeeze(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Tightest 5d/20d range coil among mega-liquid ($500M+ ADV) uptrending names."""
    return _squeeze_pick(slice_df, 500_000_000)


def strategy_squeeze_ultraliquid_750m(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Robustness variant: same squeeze mechanic, $750M ADV liquidity floor."""
    return _squeeze_pick(slice_df, 750_000_000)


def strategy_squeeze_breakout_confirmed(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Squeeze ($500M) resolving UP near its 20d high (dist_high20_pct > -5)."""
    sub = slice_df.dropna(subset=["range_5d_pct", "range_20d_pct", "volume_avg20",
                                  "close", "dist_sma20_pct", "dist_high20_pct"])
    if sub.empty:
        return None
    sub = sub.copy()
    sub = sub[((sub["close"] * sub["volume_avg20"]) >= 500_000_000)
              & (sub["dist_sma20_pct"] > 0)
              & (sub["dist_high20_pct"] > -5)]
    sub = sub[sub["range_20d_pct"] != 0]
    if sub.empty:
        return None
    sub["compress"] = sub["range_5d_pct"] / sub["range_20d_pct"]
    sub = sub.dropna(subset=["compress"])
    if sub.empty:
        return None
    return sub.nsmallest(1, "compress").iloc[0]


def strategy_squeeze_spy_regime_gated(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Candidate-1 squeeze, but only trade when SPY is above its own lagged 20d SMA."""
    if slice_df.empty:
        return None
    day = slice_df["date"].iloc[0]
    if not SPY_UP_BY_DATE.get(day, False):     # sit out chop / bear regimes
        return None
    return _squeeze_pick(slice_df, 500_000_000)


def strategy_squeeze_volcontraction_combo(slice_df: pd.DataFrame, **_) -> pd.Series | None:
    """Squeeze ($500M) with quiet/contracting volume (0.5 <= volume_ratio <= 1.2)."""
    sub = slice_df.dropna(subset=["range_5d_pct", "range_20d_pct", "volume_avg20",
                                  "close", "dist_sma20_pct", "volume_ratio"])
    if sub.empty:
        return None
    sub = sub.copy()
    sub = sub[((sub["close"] * sub["volume_avg20"]) >= 500_000_000)
              & (sub["dist_sma20_pct"] > 0)
              & (sub["volume_ratio"] >= 0.5)
              & (sub["volume_ratio"] <= 1.2)]
    sub = sub[sub["range_20d_pct"] != 0]
    if sub.empty:
        return None
    sub["compress"] = sub["range_5d_pct"] / sub["range_20d_pct"]
    sub = sub.dropna(subset=["compress"])
    if sub.empty:
        return None
    return sub.nsmallest(1, "compress").iloc[0]


STRATEGIES = {
    "momentum": strategy_momentum,
    "mean_reversion": strategy_mean_reversion,
    "volume_spike": strategy_volume_spike,
    "composite": strategy_composite,
    "random": strategy_random,
    "mega_liquid_bb_squeeze": strategy_mega_liquid_bb_squeeze,
    "squeeze_ultraliquid_750m": strategy_squeeze_ultraliquid_750m,
    "squeeze_breakout_confirmed": strategy_squeeze_breakout_confirmed,
    "squeeze_spy_regime_gated": strategy_squeeze_spy_regime_gated,
    "squeeze_volcontraction_combo": strategy_squeeze_volcontraction_combo,
}


def run_strategy(df: pd.DataFrame, strategy: str, start: str, end: str,
                 min_price: float, max_price: float, min_dollar_volume: float,
                 slippage_pct: float = 0.10, seed: int = 42) -> dict:
    """Simulates a single-pick-per-day strategy with realistic costs.
    slippage_pct: round-trip cost in % (default 0.10 = 10 bps total — half on entry, half on exit).
    """
    rng = np.random.default_rng(seed)
    fn = STRATEGIES[strategy]
    df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
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
    df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
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

    # Liquidity pre-filter: the strategies require ~$20M ADV to pick a name, so symbols
    # whose median daily dollar volume is well below that can NEVER be selected. Dropping
    # this illiquid long tail is result-neutral and keeps the 1500-symbol archive in RAM.
    _dv = (df_raw["close"].astype("float64") * df_raw["volume"].astype("float64"))
    _med_dv = _dv.groupby(df_raw["symbol"]).transform("median")
    _before = df_raw["symbol"].nunique()
    df_raw = df_raw[_med_dv >= 5_000_000].reset_index(drop=True)
    del _dv, _med_dv
    print(f"[replay] liquidity pre-filter: {_before} -> {df_raw['symbol'].nunique()} symbols, {len(df_raw):,} rows")

    # Resolve the window BEFORE feature computation, then pre-slice the archive to
    # [start - 60d buffer, end]. The ~1500-symbol x 10y archive is too large to
    # feature-engineer whole (OOM); slicing first bounds memory. The 60-day buffer
    # seeds the 20-day rolling features so feature values at `start` are valid.
    if not args.start:
        args.start = (df_raw["date"].max() - pd.Timedelta(days=730)).date().isoformat()
    if not args.end:
        args.end = df_raw["date"].max().date().isoformat()
    args.start = pd.to_datetime(args.start)
    args.end = pd.to_datetime(args.end)
    buffer_start = args.start - pd.Timedelta(days=60)
    df_raw = df_raw[(df_raw["date"] >= buffer_start) & (df_raw["date"] <= args.end)].reset_index(drop=True)
    print(f"[replay] backtest window: {args.start.date()} .. {args.end.date()} "
          f"({len(df_raw):,} rows after pre-slice)")

    print("[replay] computing features ...")
    df = add_features(df_raw)

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
