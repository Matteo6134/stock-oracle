"""
build_minute_archive.py — Rolling 1-minute bar archive from Alpaca Data API.

Keeps a ~60-day window of minute bars for the most liquid symbols in the daily
archive (default top 150 by 20d median dollar volume). Used by
intraday_stats.py to backtest same-day entry timing for the bot's setups.

Free (Basic) plan notes: historical SIP data is available as long as the
request ends >15 minutes in the past; we request end=now-16min and fall back
to feed=iex on 403.

Usage:
  python build_minute_archive.py                 # build/refresh default window
  python build_minute_archive.py --days 30 --top 50
"""
from __future__ import annotations

import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).parent
DAILY_ARCHIVE = HERE / "archive" / "ohlcv_daily.parquet"
MINUTE_OUT = HERE / "archive" / "minute_bars.parquet"
META_OUT = HERE / "archive" / "minute_meta.json"

BASE = "https://data.alpaca.markets/v2/stocks/bars"


def load_env_keys() -> tuple[str, str]:
    env = (HERE.parent.parent / ".env").read_text(encoding="utf-8", errors="ignore")
    keys = {}
    for line in env.splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            keys[k.strip()] = v.strip()
    return keys.get("ALPACA_API_KEY", ""), keys.get("ALPACA_SECRET_KEY", "")


def top_liquid_symbols(top: int) -> list[str]:
    df = pd.read_parquet(DAILY_ARCHIVE, columns=["date", "symbol", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    recent = df[df["date"] >= df["date"].max() - pd.Timedelta(days=40)]
    dv = (recent["close"] * recent["volume"]).groupby(recent["symbol"]).median()
    # Yahoo-style class shares (BRK-B) → Alpaca format (BRK.B)
    return [s.replace("-", ".") for s in dv.sort_values(ascending=False).head(top).index.tolist()]


def fetch_bars(symbols: list[str], start: str, end: str, key: str, secret: str,
               feed: str = "sip") -> pd.DataFrame:
    headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
    frames: list[pd.DataFrame] = []
    page_token = None
    pages = 0
    while True:
        params = {
            "symbols": ",".join(symbols), "timeframe": "1Min",
            "start": start, "end": end, "limit": 10000,
            "adjustment": "split", "feed": feed,
        }
        if page_token:
            params["page_token"] = page_token
        r = requests.get(BASE, headers=headers, params=params, timeout=60)
        if r.status_code == 403 and feed == "sip":
            print("[minute] SIP not allowed on this plan — falling back to IEX feed")
            return fetch_bars(symbols, start, end, key, secret, feed="iex")
        if r.status_code == 429:
            time.sleep(10)
            continue
        r.raise_for_status()
        data = r.json()
        for sym, bars in (data.get("bars") or {}).items():
            if not bars:
                continue
            f = pd.DataFrame(bars)
            f["symbol"] = sym
            frames.append(f)
        page_token = data.get("next_page_token")
        pages += 1
        if pages % 50 == 0:
            print(f"[minute] {pages} pages, {sum(len(f) for f in frames):,} bars so far ...")
        if not page_token:
            break
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out = out.rename(columns={"t": "ts", "o": "open", "h": "high", "l": "low",
                              "c": "close", "v": "volume"})
    out["ts"] = pd.to_datetime(out["ts"], utc=True)
    return out[["symbol", "ts", "open", "high", "low", "close", "volume"]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60, help="Rolling window length")
    ap.add_argument("--top", type=int, default=150, help="Top N symbols by $ volume")
    args = ap.parse_args()

    key, secret = load_env_keys()
    if not key:
        raise SystemExit("[minute] no ALPACA_API_KEY in .env")

    symbols = top_liquid_symbols(args.top)
    end_dt = datetime.now(timezone.utc) - timedelta(minutes=16)
    window_start = end_dt - timedelta(days=args.days)

    # Incremental: keep existing rows inside the window, fetch only what's new
    existing = pd.DataFrame()
    fetch_start = window_start
    if MINUTE_OUT.exists():
        existing = pd.read_parquet(MINUTE_OUT)
        existing["ts"] = pd.to_datetime(existing["ts"], utc=True)
        existing = existing[existing["ts"] >= pd.Timestamp(window_start)]
        if len(existing):
            fetch_start = max(window_start, existing["ts"].max().to_pydatetime() - timedelta(hours=1))

    print(f"[minute] {len(symbols)} symbols, fetching {fetch_start.date()} → {end_dt.date()} ...")
    chunks = [symbols[i:i + 50] for i in range(0, len(symbols), 50)]
    fresh_frames = []
    for i, chunk in enumerate(chunks):
        fresh_frames.append(fetch_bars(chunk, fetch_start.isoformat(), end_dt.isoformat(), key, secret))
        print(f"[minute] chunk {i + 1}/{len(chunks)} done")
    fresh = pd.concat([f for f in fresh_frames if len(f)], ignore_index=True) if fresh_frames else pd.DataFrame()

    combined = pd.concat([existing, fresh], ignore_index=True) if len(existing) else fresh
    if combined.empty:
        raise SystemExit("[minute] no data fetched")
    combined = combined.drop_duplicates(subset=["symbol", "ts"]).sort_values(["symbol", "ts"])

    combined.to_parquet(MINUTE_OUT, index=False)
    META_OUT.write_text(json.dumps({
        "rows": int(len(combined)),
        "symbols": int(combined["symbol"].nunique()),
        "ts_min": str(combined["ts"].min()),
        "ts_max": str(combined["ts"].max()),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2), encoding="utf-8")
    print(f"[minute] wrote {len(combined):,} rows / {combined['symbol'].nunique()} symbols → {MINUTE_OUT.name}")


if __name__ == "__main__":
    main()
