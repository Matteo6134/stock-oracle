"""
setup_stats.py — Historical analog statistics for live predictions.

For every (symbol, day) in the OHLCV archive (1999 → today after the full
rebuild), detects the price/volume setups the live bot trades, buckets them by
VIX regime, and measures what ACTUALLY happened 5 and 10 days later.

Outputs (consumed by server/services/analogStats.js):
  archive/setup_stats.json — per setup & setup-pair: n, hit+10% rate, avg/median
      forward returns, by VIX regime, with train(<2023)/validate(>=2023) split
  archive/macro_stats.json — SPY forward-return distribution for every
      (VIX regime, trend, drawdown bucket) since 1999 + today's bucket

Run weekly (Sunday 5 AM ET cron in server/index.js) — takes a few minutes.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
ARCHIVE = HERE / "archive" / "ohlcv_daily.parquet"
SETUP_OUT = HERE / "archive" / "setup_stats.json"
MACRO_OUT = HERE / "archive" / "macro_stats.json"

TRAIN_CUTOFF = "2023-01-01"
MIN_PRICE, MAX_PRICE = 1.0, 400.0
MIN_DOLLAR_VOL = 5_000_000  # 20d median $ volume — tradability floor
HIT_TARGET = 0.10           # "the prediction": +10%
EXIT_TARGETS = [8, 10, 12, 15, 20, 25]  # %, for the exit sweep


def fetch_market_context() -> pd.DataFrame:
    """SPY + ^VIX daily closes since 1999 → regime/trend per date."""
    import yfinance as yf
    raw = yf.download(["SPY", "^VIX"], start="1999-01-01", interval="1d",
                      auto_adjust=True, progress=False)["Close"]
    ctx = pd.DataFrame({"spy": raw["SPY"], "vix": raw["^VIX"]}).dropna(subset=["spy"])
    ctx["vix"] = ctx["vix"].ffill()
    ctx["sma200"] = ctx["spy"].rolling(200, min_periods=100).mean()
    ctx["trend"] = np.where(ctx["spy"] >= ctx["sma200"], "up", "down")
    ctx["vix_regime"] = pd.cut(ctx["vix"], bins=[0, 17, 25, 1000],
                               labels=["calm", "elevated", "panic"]).astype(str)
    ctx["ath"] = ctx["spy"].cummax()
    dd = ctx["spy"] / ctx["ath"] - 1.0
    ctx["dd_bucket"] = pd.cut(dd, bins=[-1, -0.15, -0.05, 0.001],
                              labels=["deep_dd", "pullback", "near_ath"]).astype(str)
    # SPY forward returns for the macro radar
    ctx["spy_fwd21"] = ctx["spy"].shift(-21) / ctx["spy"] - 1.0
    ctx["spy_fwd63"] = ctx["spy"].shift(-63) / ctx["spy"] - 1.0
    ctx.index = pd.to_datetime(ctx.index).tz_localize(None).normalize()
    return ctx


def future_extreme(s: pd.Series, window: int, kind: str) -> pd.Series:
    """Max (or min) over the NEXT `window` bars, excluding today."""
    fut = s.shift(-1).iloc[::-1]
    rolled = fut.rolling(window, min_periods=max(2, window // 2))
    out = (rolled.max() if kind == "max" else rolled.min()).iloc[::-1]
    return out


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", sort=False)

    df["vol20"] = g["volume"].transform(lambda s: s.rolling(20, min_periods=10).mean())
    df["vol5"] = g["volume"].transform(lambda s: s.rolling(5, min_periods=3).mean())
    df["vr"] = df["volume"] / df["vol20"]
    df["contraction"] = df["vol5"] / df["vol20"]
    df["ret5"] = g["close"].transform(lambda s: s.pct_change(5))
    df["high20"] = g["high"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).max())
    std20 = g["close"].transform(lambda s: s.rolling(20, min_periods=10).std())
    mean20 = g["close"].transform(lambda s: s.rolling(20, min_periods=10).mean())
    df["bbw"] = (4 * std20) / mean20
    df["bbw_rank"] = g["bbw"].transform(
        lambda s: s.rolling(120, min_periods=60).rank(pct=True))
    df["dv20"] = (df["close"] * df["volume"]).groupby(df["symbol"]).transform(
        lambda s: s.rolling(20, min_periods=10).median())

    # Forward outcomes
    df["fwd5_close"] = g["close"].transform(lambda s: s.shift(-5) / s - 1.0)
    df["fwd10_close"] = g["close"].transform(lambda s: s.shift(-10) / s - 1.0)
    df["fwd5_max"] = g["high"].transform(lambda s: future_extreme(s, 5, "max")) / df["close"] - 1.0
    df["fwd10_max"] = g["high"].transform(lambda s: future_extreme(s, 10, "max")) / df["close"] - 1.0
    return df


def detect_setups(df: pd.DataFrame) -> dict[str, pd.Series]:
    """Boolean mask per setup — mirrors the live bot's price/volume signals."""
    return {
        "volume_contraction": (df["contraction"] <= 0.55) & (df["ret5"].abs() <= 0.06),
        "bb_squeeze": df["bbw_rank"] <= 0.20,
        "unusual_volume": df["vr"] >= 3.0,
        "breakout": (df["close"] >= df["high20"] * 0.99) & (df["vr"] >= 1.5),
        "momentum": (df["ret5"].between(0.05, 0.20)) & (df["vr"] >= 1.2),
    }


def agg_block(sub: pd.DataFrame) -> dict | None:
    sub = sub.dropna(subset=["fwd5_close", "fwd5_max"])
    n = len(sub)
    if n < 30:
        return None
    return {
        "n": int(n),
        "hit10_5d": round(float((sub["fwd5_max"] >= HIT_TARGET).mean()), 4),
        "avg_fwd5": round(float(sub["fwd5_close"].mean()) * 100, 3),
        "med_fwd5": round(float(sub["fwd5_close"].median()) * 100, 3),
        "avg_fwd10": round(float(sub["fwd10_close"].mean()) * 100, 3),
    }


def main() -> None:
    print("[setup_stats] loading archive ...")
    df = pd.read_parquet(ARCHIVE)
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df = df[(df["close"] >= MIN_PRICE) & (df["close"] <= MAX_PRICE)]
    print(f"[setup_stats] {len(df):,} rows, {df['symbol'].nunique()} symbols, "
          f"{df['date'].min().date()} .. {df['date'].max().date()}")

    ctx = fetch_market_context()
    df = build_features(df)
    df = df[df["dv20"] >= MIN_DOLLAR_VOL]
    df = df.merge(ctx[["vix_regime", "trend"]], left_on="date", right_index=True, how="left")
    df["vix_regime"] = df["vix_regime"].fillna("elevated")
    train_mask = df["date"] < TRAIN_CUTOFF

    setups = detect_setups(df)
    names = list(setups.keys())
    keys: dict[str, pd.Series] = dict(setups)
    for i in range(len(names)):           # pair combos
        for j in range(i + 1, len(names)):
            keys[f"{names[i]}+{names[j]}"] = setups[names[i]] & setups[names[j]]

    out: dict = {"generated_at": datetime.now(timezone.utc).isoformat(),
                 "window": [str(df["date"].min().date()), str(df["date"].max().date())],
                 "hit_target_pct": HIT_TARGET * 100, "setups": {}}

    any_setup = pd.Series(False, index=df.index)
    for name, mask in keys.items():
        mask = mask.fillna(False)
        if "+" not in name:
            any_setup |= mask
        sub = df[mask]
        block = agg_block(sub)
        if block is None:
            continue
        entry = {"all": block, "by_regime": {}, "train": agg_block(sub[train_mask[mask.index][mask]]),
                 "validate": agg_block(sub[~train_mask[mask.index][mask]])}
        for regime, rsub in sub.groupby("vix_regime"):
            rblock = agg_block(rsub)
            if rblock:
                entry["by_regime"][regime] = rblock
        out["setups"][name] = entry
        print(f"[setup_stats] {name}: n={block['n']:,} hit10={block['hit10_5d']:.0%} avg5d={block['avg_fwd5']:+.2f}%")

    # Regime baseline (all setup-days) — used as a sizing multiplier
    base = df[any_setup]
    out["regime_baseline"] = {}
    overall = agg_block(base)
    if overall:
        out["regime_baseline"]["all"] = overall
        for regime, rsub in base.groupby("vix_regime"):
            b = agg_block(rsub)
            if b:
                out["regime_baseline"][regime] = b

    # Exit-target sweep on setup-days (never-sell-red world: losers held to 10d)
    sweep = {}
    sdays = base.dropna(subset=["fwd10_max", "fwd10_close"])
    for tgt in EXIT_TARGETS:
        t = tgt / 100
        hit = sdays["fwd10_max"] >= t
        realized = np.where(hit, t, sdays["fwd10_close"])
        sweep[str(tgt)] = {"hit_rate": round(float(hit.mean()), 4),
                           "avg_realized_pct": round(float(np.mean(realized)) * 100, 3)}
    out["exit_sweep"] = sweep
    best = max(sweep.items(), key=lambda kv: kv[1]["avg_realized_pct"])
    out["exit_sweep_best"] = {"target_pct": int(best[0]), **best[1]}
    print(f"[setup_stats] best exit target: +{best[0]}% (avg realized {best[1]['avg_realized_pct']:+.2f}%/trade)")

    SETUP_OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")

    # ── Macro radar: SPY forward distribution per (regime, trend, drawdown) ──
    macro: dict = {"generated_at": out["generated_at"], "buckets": {}}
    mctx = ctx.dropna(subset=["spy_fwd21"])
    for (reg, tr, dd), sub in mctx.groupby(["vix_regime", "trend", "dd_bucket"]):
        if len(sub) < 60:
            continue
        f63 = sub["spy_fwd63"].dropna()
        macro["buckets"][f"{reg}|{tr}|{dd}"] = {
            "n_days": int(len(sub)),
            "fwd21_med": round(float(sub["spy_fwd21"].median()) * 100, 2),
            "fwd21_p10": round(float(sub["spy_fwd21"].quantile(0.10)) * 100, 2),
            "fwd21_p90": round(float(sub["spy_fwd21"].quantile(0.90)) * 100, 2),
            "fwd63_med": round(float(f63.median()) * 100, 2) if len(f63) else None,
            "fwd63_p10": round(float(f63.quantile(0.10)) * 100, 2) if len(f63) else None,
        }
    last = ctx.iloc[-1]
    macro["today"] = {"date": str(ctx.index[-1].date()), "spy": round(float(last["spy"]), 2),
                      "vix": round(float(last["vix"]), 2), "vix_regime": last["vix_regime"],
                      "trend": last["trend"], "dd_bucket": last["dd_bucket"],
                      "bucket_key": f"{last['vix_regime']}|{last['trend']}|{last['dd_bucket']}"}
    MACRO_OUT.write_text(json.dumps(macro, indent=1), encoding="utf-8")
    print(f"[setup_stats] today's macro bucket: {macro['today']['bucket_key']}")
    print(f"[setup_stats] wrote {SETUP_OUT.name} + {MACRO_OUT.name}")


if __name__ == "__main__":
    main()
