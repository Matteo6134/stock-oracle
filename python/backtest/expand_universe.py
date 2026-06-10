"""
Expand the universe — merges curated 262 with Russell 2000 + NASDAQ-listed
optionable + S&P 1500, then filters by liquidity to keep tradable names only.

Sources (all free):
  - Curated 262         from python/monkey/universe.json (current bot universe)
  - Russell 2000        Wikipedia or iShares IWM holdings CSV
  - S&P 500             Wikipedia
  - NASDAQ-listed       NASDAQ FTP nasdaqlisted.txt
  - NYSE-listed         NASDAQ FTP otherlisted.txt

Liquidity filter:
  - price >= $1, <= $500
  - 20-day avg dollar volume >= $5M  (configurable)

Outputs:
  - python/monkey/universe_expanded.json    (full candidate list)
  - python/monkey/universe_active.json      (post-liquidity filter — what to scan)

Run:
  python expand_universe.py                              # default 1500 cap
  python expand_universe.py --target-size 3000           # bigger
  python expand_universe.py --min-dollar-volume 10000000 # tighter liquidity
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[2]
MONKEY_DIR = ROOT / "python" / "monkey"
CURATED_FILE = MONKEY_DIR / "universe.json"
EXPANDED_FILE = MONKEY_DIR / "universe_expanded.json"
ACTIVE_FILE = MONKEY_DIR / "universe_active.json"

HEADERS = {"User-Agent": "Mozilla/5.0 (universe-expander)"}

# ─── Source loaders ─────────────────────────────────────────────────────────


def load_curated() -> list[str]:
    if not CURATED_FILE.exists():
        return []
    return json.loads(CURATED_FILE.read_text(encoding="utf-8"))["symbols"]


def load_sp500() -> list[str]:
    """Wikipedia table of current S&P 500 constituents."""
    try:
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
        tables = pd.read_html(url, storage_options=HEADERS)
        df = tables[0]
        col = [c for c in df.columns if "symbol" in str(c).lower()][0]
        return [str(s).strip().upper().replace(".", "-") for s in df[col].tolist()]
    except Exception as exc:
        print(f"[expand] sp500 fetch failed: {exc}", file=sys.stderr)
        return []


def load_russell2000() -> list[str]:
    """iShares IWM (Russell 2000 ETF) holdings CSV — most authoritative free source."""
    try:
        url = ("https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/"
               "1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund")
        r = requests.get(url, headers=HEADERS, timeout=20)
        r.raise_for_status()
        # iShares CSVs have a metadata preamble — skip until we find the header row
        text = r.text
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("Ticker") or "Ticker," in line:
                csv_body = "\n".join(lines[i:])
                df = pd.read_csv(io.StringIO(csv_body))
                col = [c for c in df.columns if "ticker" in str(c).lower()][0]
                return [str(s).strip().upper().replace(".", "-") for s in df[col].dropna().tolist()
                        if re.match(r"^[A-Z\-]{1,6}$", str(s).strip().upper())]
        return []
    except Exception as exc:
        print(f"[expand] russell2000 fetch failed: {exc}", file=sys.stderr)
        return []


def load_nasdaq_listed() -> list[str]:
    """NASDAQ FTP list of NASDAQ-listed equities."""
    try:
        url = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&exchange=NASDAQ"
        r = requests.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=20)
        r.raise_for_status()
        data = r.json()
        rows = data.get("data", {}).get("rows") or data.get("data", {}).get("table", {}).get("rows", [])
        return [str(row.get("symbol", "")).strip().upper() for row in rows
                if row.get("symbol") and re.match(r"^[A-Z\-]{1,6}$", str(row.get("symbol", "")).strip().upper())]
    except Exception as exc:
        print(f"[expand] nasdaq screener fetch failed: {exc}", file=sys.stderr)
        return []


# ─── Liquidity filter ───────────────────────────────────────────────────────


def filter_by_liquidity(symbols: list[str], min_price: float, max_price: float,
                        min_dollar_volume: float, lookback_days: int = 20,
                        chunk_size: int = 100) -> list[dict]:
    """Bulk-fetch recent OHLCV and filter by price + dollar-volume."""
    import yfinance as yf
    end = datetime.utcnow().date()
    start = end - timedelta(days=lookback_days + 5)
    keep: list[dict] = []
    for i in range(0, len(symbols), chunk_size):
        batch = symbols[i:i + chunk_size]
        idx = i // chunk_size + 1
        n_chunks = (len(symbols) + chunk_size - 1) // chunk_size
        print(f"[expand] liquidity chunk {idx}/{n_chunks} ({len(batch)} syms)")
        try:
            df = yf.download(
                tickers=batch, start=start.isoformat(), end=(end + timedelta(days=1)).isoformat(),
                interval="1d", auto_adjust=False, group_by="ticker", progress=False, threads=True,
            )
        except Exception as exc:
            print(f"[expand]   chunk failed: {exc}", file=sys.stderr)
            continue
        for sym in batch:
            try:
                sub = df[sym] if sym in df.columns.levels[0] else None
            except (AttributeError, KeyError):
                sub = None
            if sub is None or sub.empty:
                continue
            recent = sub.dropna(how="all").tail(lookback_days)
            if recent.empty:
                continue
            avg_close = float(recent["Close"].mean())
            avg_vol = float(recent["Volume"].mean())
            if not (min_price <= avg_close <= max_price):
                continue
            dollar_vol = avg_close * avg_vol
            if dollar_vol < min_dollar_volume:
                continue
            keep.append({
                "symbol": sym,
                "avg_close": round(avg_close, 2),
                "avg_volume": int(avg_vol),
                "dollar_volume": int(dollar_vol),
            })
        time.sleep(0.5)
    return keep


# ─── Main ──────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-size", type=int, default=1500,
                    help="Approximate cap on active universe size after liquidity filter")
    ap.add_argument("--min-price", type=float, default=1.0)
    ap.add_argument("--max-price", type=float, default=500.0)
    ap.add_argument("--min-dollar-volume", type=float, default=5_000_000)
    ap.add_argument("--lookback-days", type=int, default=20)
    ap.add_argument("--skip-liquidity", action="store_true",
                    help="Just merge sources and dump, no Yahoo liquidity check")
    args = ap.parse_args()

    print("[expand] loading sources ...")
    curated = load_curated()
    sp500 = load_sp500()
    russell = load_russell2000()
    nasdaq = load_nasdaq_listed()
    print(f"[expand]   curated: {len(curated)}")
    print(f"[expand]   S&P500 : {len(sp500)}")
    print(f"[expand]   Russell: {len(russell)}")
    print(f"[expand]   NASDAQ : {len(nasdaq)}")

    merged = sorted(set(s for s in (curated + sp500 + russell + nasdaq) if s and s.isalnum() or "-" in s))
    merged = [s for s in merged if re.match(r"^[A-Z\-]{1,6}$", s)]
    print(f"[expand] merged & deduped: {len(merged)} symbols")

    EXPANDED_FILE.write_text(json.dumps({
        "source": "expand_universe.py merged: curated+sp500+russell2000+nasdaq",
        "extracted_at": datetime.utcnow().isoformat() + "Z",
        "count": len(merged),
        "symbols": merged,
        "sources": {
            "curated": len(curated),
            "sp500": len(sp500),
            "russell2000": len(russell),
            "nasdaq": len(nasdaq),
        },
    }, indent=2), encoding="utf-8")
    print(f"[expand] wrote {EXPANDED_FILE}")

    if args.skip_liquidity:
        return

    print(f"[expand] running liquidity filter (price ${args.min_price}-{args.max_price}, "
          f"$DV >= ${args.min_dollar_volume:,.0f}, {args.lookback_days}d lookback) ...")
    survivors = filter_by_liquidity(merged, args.min_price, args.max_price,
                                     args.min_dollar_volume, args.lookback_days)
    print(f"[expand] {len(survivors)} symbols passed liquidity filter")

    survivors.sort(key=lambda x: -x["dollar_volume"])
    if len(survivors) > args.target_size:
        survivors = survivors[:args.target_size]
        print(f"[expand] capped to top {args.target_size} by dollar volume")

    ACTIVE_FILE.write_text(json.dumps({
        "source": "expand_universe.py liquidity-filtered",
        "extracted_at": datetime.utcnow().isoformat() + "Z",
        "filter": {
            "min_price": args.min_price,
            "max_price": args.max_price,
            "min_dollar_volume": args.min_dollar_volume,
            "lookback_days": args.lookback_days,
        },
        "count": len(survivors),
        "symbols": [s["symbol"] for s in survivors],
        "details": survivors,
    }, indent=2), encoding="utf-8")
    print(f"[expand] wrote {ACTIVE_FILE}")
    if survivors:
        med = survivors[len(survivors) // 2]
        print(f"[expand] median dollar volume in active set: ${med['dollar_volume']:,}")


if __name__ == "__main__":
    main()
