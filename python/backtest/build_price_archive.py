"""
Build local price archive for the bot's universe.
==================================================
Downloads daily OHLCV for every symbol in python/monkey/universe.json over a
3-year window (configurable) from Yahoo, stores it as a single Parquet file
for fast columnar queries.

Run once, then refresh weekly:
  python build_price_archive.py
  python build_price_archive.py --years 5
  python build_price_archive.py --refresh-since 2026-01-01
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
UNIVERSE_FILE = ROOT / "python" / "monkey" / "universe.json"
ARCHIVE_DIR = Path(__file__).parent / "archive"
ARCHIVE_FILE = ARCHIVE_DIR / "ohlcv_daily.parquet"
META_FILE = ARCHIVE_DIR / "ohlcv_meta.json"


def load_universe() -> list[str]:
    if not UNIVERSE_FILE.exists():
        print(f"ERROR: {UNIVERSE_FILE} not found — run universe extractor first", file=sys.stderr)
        sys.exit(2)
    return json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))["symbols"]


def download_chunk(symbols: list[str], start: str, end: str, attempt: int = 1) -> pd.DataFrame:
    """yfinance bulk download with retry."""
    try:
        df = yf.download(
            tickers=symbols,
            start=start,
            end=end,
            interval="1d",
            auto_adjust=False,
            group_by="ticker",
            progress=False,
            threads=True,
        )
        return df
    except Exception as exc:
        if attempt >= 3:
            print(f"[archive] chunk failed after 3 attempts: {exc}", file=sys.stderr)
            return pd.DataFrame()
        print(f"[archive] chunk failed (attempt {attempt}), retrying in 5s: {exc}")
        time.sleep(5)
        return download_chunk(symbols, start, end, attempt + 1)


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Reshape yfinance multi-index DataFrame into long-format
    (date, symbol, open, high, low, close, adj_close, volume)."""
    if df.empty:
        return df
    rows = []
    for sym in df.columns.levels[0]:
        try:
            sub = df[sym].copy()
        except KeyError:
            continue
        sub = sub.dropna(how="all")
        if sub.empty:
            continue
        sub = sub.reset_index()
        sub.columns = [c.lower().replace(" ", "_") for c in sub.columns]
        sub["symbol"] = sym
        rows.append(sub)
    if not rows:
        return pd.DataFrame()
    out = pd.concat(rows, ignore_index=True)
    out["o2c_return_pct"] = (out["close"] - out["open"]) / out["open"] * 100.0
    out["c2c_return_pct"] = out.groupby("symbol")["close"].pct_change() * 100.0
    return out[["date", "symbol", "open", "high", "low", "close", "adj_close", "volume",
                "o2c_return_pct", "c2c_return_pct"]]


def build(years: int = 3, chunk_size: int = 50, refresh_since: str | None = None) -> pd.DataFrame:
    universe = load_universe()
    end = datetime.utcnow().date()
    if refresh_since:
        start = datetime.fromisoformat(refresh_since).date()
    else:
        start = end - timedelta(days=int(years * 365.25))
    print(f"[archive] {len(universe)} symbols, {start} .. {end}, chunks of {chunk_size}")

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    chunks: list[pd.DataFrame] = []
    n_chunks = (len(universe) + chunk_size - 1) // chunk_size
    for i in range(0, len(universe), chunk_size):
        batch = universe[i:i + chunk_size]
        idx = i // chunk_size + 1
        print(f"[archive] chunk {idx}/{n_chunks} — {len(batch)} symbols")
        raw = download_chunk(batch, start.isoformat(), (end + timedelta(days=1)).isoformat())
        norm = normalize(raw)
        if not norm.empty:
            chunks.append(norm)
        time.sleep(1.0)            # politeness — Yahoo will throttle without a pause

    if not chunks:
        print("[archive] no data fetched", file=sys.stderr)
        sys.exit(1)
    df = pd.concat(chunks, ignore_index=True)
    df = df.dropna(subset=["open", "close"])
    df["date"] = pd.to_datetime(df["date"]).dt.date.astype(str)
    return df


def merge_with_existing(new_df: pd.DataFrame) -> pd.DataFrame:
    if not ARCHIVE_FILE.exists():
        return new_df
    existing = pd.read_parquet(ARCHIVE_FILE)
    print(f"[archive] merging with existing archive ({len(existing)} rows)")
    combined = pd.concat([existing, new_df], ignore_index=True)
    combined = combined.drop_duplicates(subset=["date", "symbol"], keep="last")
    combined = combined.sort_values(["symbol", "date"]).reset_index(drop=True)
    return combined


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=3)
    ap.add_argument("--chunk-size", type=int, default=50)
    ap.add_argument("--refresh-since", default=None,
                    help="Only download from this date onwards (YYYY-MM-DD). Used for incremental updates.")
    ap.add_argument("--rebuild", action="store_true", help="Discard existing archive and rebuild from scratch")
    args = ap.parse_args()

    new_df = build(years=args.years, chunk_size=args.chunk_size, refresh_since=args.refresh_since)
    print(f"[archive] downloaded {len(new_df)} rows")

    if args.rebuild or not ARCHIVE_FILE.exists():
        out_df = new_df
    else:
        out_df = merge_with_existing(new_df)

    out_df.to_parquet(ARCHIVE_FILE, index=False, compression="snappy")
    print(f"[archive] wrote {len(out_df)} rows to {ARCHIVE_FILE}")

    n_syms = out_df["symbol"].nunique()
    date_min = out_df["date"].min()
    date_max = out_df["date"].max()
    meta = {
        "rows": int(len(out_df)),
        "symbols": int(n_syms),
        "date_min": str(date_min),
        "date_max": str(date_max),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[archive] {n_syms} symbols, {date_min} .. {date_max}")


if __name__ == "__main__":
    main()
