"""
intraday_stats.py — Entry-timing statistics from the minute-bar archive.

For each (symbol, day) in the minute archive where one of the bot's daily
setups was active the PRIOR day (signal day → trade next day, like the live
bot), simulate buying at several intraday entry times and measure the return
to the same-day close. Answers: "when during the day should the bot buy?"

Output: archive/intraday_stats.json (consumed by analogStats.js / macro radar)
"""
from __future__ import annotations

import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
DAILY = HERE / "archive" / "ohlcv_daily.parquet"
MINUTE = HERE / "archive" / "minute_bars.parquet"
OUT = HERE / "archive" / "intraday_stats.json"

ENTRY_TIMES = ["09:35", "10:00", "10:30", "11:30", "13:00", "14:30", "15:30"]


def daily_setup_days(symbols: list[str], since: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_parquet(DAILY, columns=["date", "symbol", "close", "high", "volume"])
    df = df[df["symbol"].isin(symbols)]
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df = df[df["date"] >= since - pd.Timedelta(days=60)]
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", sort=False)
    vol20 = g["volume"].transform(lambda s: s.rolling(20, min_periods=10).mean())
    vol5 = g["volume"].transform(lambda s: s.rolling(5, min_periods=3).mean())
    vr = df["volume"] / vol20
    contraction = vol5 / vol20
    ret5 = g["close"].transform(lambda s: s.pct_change(5))
    high20 = g["high"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).max())
    std20 = g["close"].transform(lambda s: s.rolling(20, min_periods=10).std())
    mean20 = g["close"].transform(lambda s: s.rolling(20, min_periods=10).mean())
    bbw_rank = ((4 * std20) / mean20).groupby(df["symbol"]).transform(
        lambda s: s.rolling(120, min_periods=60).rank(pct=True))

    setup = (
        ((contraction <= 0.55) & (ret5.abs() <= 0.06)) |
        (bbw_rank <= 0.20) |
        (vr >= 3.0) |
        ((df["close"] >= high20 * 0.99) & (vr >= 1.5)) |
        (ret5.between(0.05, 0.20) & (vr >= 1.2))
    ).fillna(False)

    out = df.loc[setup, ["symbol", "date"]].copy()
    # The live bot trades the day AFTER the signal day
    out["trade_date"] = out["date"] + pd.offsets.BDay(1)
    return out[["symbol", "trade_date"]]


def main() -> None:
    minute = pd.read_parquet(MINUTE)
    # Alpaca class-share format (BRK.B) → daily-archive format (BRK-B)
    minute["symbol"] = minute["symbol"].str.replace(".", "-", regex=False)
    minute["ts"] = pd.to_datetime(minute["ts"], utc=True).dt.tz_convert("America/New_York")
    minute["trade_date"] = minute["ts"].dt.normalize().dt.tz_localize(None)
    minute["hhmm"] = minute["ts"].dt.strftime("%H:%M")
    # Regular session only
    minute = minute[(minute["hhmm"] >= "09:30") & (minute["hhmm"] <= "16:00")]
    print(f"[intraday] {len(minute):,} session bars, {minute['symbol'].nunique()} symbols, "
          f"{minute['trade_date'].min().date()} → {minute['trade_date'].max().date()}")

    symbols = minute["symbol"].unique().tolist()
    setups = daily_setup_days(symbols, minute["trade_date"].min())
    setups["trade_date"] = pd.to_datetime(setups["trade_date"]).dt.normalize()

    # Keep only minute data on setup trade-days
    m = minute.merge(setups.drop_duplicates(), on=["symbol", "trade_date"], how="inner")
    if m.empty:
        raise SystemExit("[intraday] no overlap between setups and minute data")
    n_days = m.groupby(["symbol", "trade_date"]).ngroups
    print(f"[intraday] {n_days:,} setup trade-days with minute coverage")

    # Closing price per (symbol, day) = last bar close
    closes = m.sort_values("ts").groupby(["symbol", "trade_date"])["close"].last().rename("day_close")

    out = {"generated_at": datetime.now(timezone.utc).isoformat(),
           "n_setup_days": int(n_days), "by_entry": {}}
    for t in ENTRY_TIMES:
        # First bar at or after the entry time
        after = m[m["hhmm"] >= t].sort_values("ts")
        entry = after.groupby(["symbol", "trade_date"]).first()
        joined = entry.join(closes, how="inner")
        ret = joined["day_close"] / joined["close"] - 1.0
        ret = ret.dropna()
        if len(ret) < 50:
            continue
        out["by_entry"][t] = {
            "n": int(len(ret)),
            "avg_to_close_pct": round(float(ret.mean()) * 100, 3),
            "med_to_close_pct": round(float(ret.median()) * 100, 3),
            "win_rate": round(float((ret > 0).mean()), 4),
        }
        print(f"[intraday] entry {t}: n={len(ret):,} avg→close {ret.mean()*100:+.3f}% win {((ret>0).mean())*100:.0f}%")

    if out["by_entry"]:
        best = max(out["by_entry"].items(), key=lambda kv: kv[1]["avg_to_close_pct"])
        out["best_entry"] = {"time": best[0], **best[1]}
        print(f"[intraday] best entry: {best[0]} ({best[1]['avg_to_close_pct']:+.3f}% avg to close)")
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"[intraday] wrote {OUT.name}")


if __name__ == "__main__":
    main()
