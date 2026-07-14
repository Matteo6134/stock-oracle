"""
Daily Sector Gate — computes which sectors are in favor and which names inside
them look like disciplined entries, for the live bot to consume.

Backtest basis (sector_rotation_backtest.py): gating entries to the top-3
sectors by 20d momentum and picking MODERATE momentum names (60-85th
percentile, not the parabolic leaders) beat the monkey distribution; buying
the extended leaders lost badly.

Fetches the last ~40 trading days of closes for the active universe straight
from Yahoo (chunked batch download, ~1-2 min), so it does not depend on the
weekly archive refresh.

Output: server/data/sectorGate.json
  {
    "updated_at": ISO,
    "top_sectors": ["Health Care", ...],
    "sector_momentum_pct": {"Health Care": 4.1, ...},
    "sector_of": {"SYM": "Sector", ...},          # for the autoTrader gate
    "candidates": ["SYM", ...]                     # moderate-momentum names in top sectors
  }

Run (daily, premarket):  python python/backtest/sector_gate.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
UNIVERSE_FILE = ROOT / "python" / "monkey" / "universe.json"
SECTORS_FILE = ROOT / "python" / "backtest" / "archive" / "sectors.json"
OUT_FILE = ROOT / "server" / "data" / "sectorGate.json"

N_SECTORS = 3
MOM_WINDOW = 20          # trading days
MIN_DOLLAR_VOLUME = 20_000_000
MIN_PRICE, MAX_PRICE = 1.0, 400.0
PCTILE_LO, PCTILE_HI = 0.60, 0.85   # moderate momentum band
MAX_CANDIDATES = 40
CHUNK = 300

# Daily scan universe (replaces every hardcoded ticker list in the Node scanners)
SCAN_ADV = 10_000_000        # scannable liquidity floor
SCAN_TOP_SECTOR_CAP = 150    # liquid members of the top sectors
SCAN_BROAD_CAP = 100         # highest-ADV names market-wide (keeps eyes on megacap moves)
PENNY_MAX_PRICE = 5.0
PENNY_ADV = 2_000_000
PENNY_CAP = 80


def load_universe() -> list[str]:
    raw = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    return raw if isinstance(raw, list) else raw["symbols"]


def load_sectors() -> dict[str, str]:
    raw = json.loads(SECTORS_FILE.read_text(encoding="utf-8"))
    return {s: v["sector"] for s, v in raw.items() if v.get("sector") and v["sector"] != "Unknown"}


def fetch_closes(symbols: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    closes_parts, volume_parts = [], []
    for i in range(0, len(symbols), CHUNK):
        batch = symbols[i:i + CHUNK]
        data = yf.download(batch, period="3mo", interval="1d", auto_adjust=True,
                           progress=False, group_by="column", threads=True)
        if data.empty:
            continue
        closes_parts.append(data["Close"])
        volume_parts.append(data["Volume"])
    closes = pd.concat(closes_parts, axis=1)
    volumes = pd.concat(volume_parts, axis=1)
    return closes.dropna(axis=1, how="all"), volumes


def main() -> None:
    symbols = load_universe()
    sector_of = load_sectors()
    symbols = [s for s in symbols if s in sector_of]
    print(f"[sector-gate] fetching {len(symbols)} symbols ...")
    closes, volumes = fetch_closes(symbols)
    print(f"[sector-gate] got closes for {closes.shape[1]} symbols, {closes.shape[0]} days")

    if closes.shape[0] < MOM_WINDOW + 2:
        print("[sector-gate] not enough history, aborting", file=sys.stderr)
        sys.exit(2)

    last = closes.iloc[-1]
    mom = (closes.iloc[-1] / closes.iloc[-(MOM_WINDOW + 1)] - 1) * 100
    adv = (closes * volumes).rolling(MOM_WINDOW).mean().iloc[-1]

    liquid = mom.index[(last >= MIN_PRICE) & (last <= MAX_PRICE) & (adv >= MIN_DOLLAR_VOLUME) & mom.notna()]
    liquid = [s for s in liquid if s in sector_of]
    if not liquid:
        print("[sector-gate] empty liquid slice, aborting", file=sys.stderr)
        sys.exit(2)

    m = mom.loc[liquid]
    sec = pd.Series({s: sector_of[s] for s in liquid})
    sec_mom = m.groupby(sec).mean().sort_values(ascending=False)
    top_sectors = list(sec_mom.head(N_SECTORS).index)

    pool = m[[s for s in liquid if sector_of[s] in top_sectors]].sort_values()
    lo, hi = int(len(pool) * PCTILE_LO), int(len(pool) * PCTILE_HI)
    candidates = list(pool.iloc[lo:hi].sort_values(ascending=False).head(MAX_CANDIDATES).index)

    # ── Daily scan universe: 100% data-driven, zero hardcoded tickers ──
    scannable = adv.index[(last >= MIN_PRICE) & (last <= MAX_PRICE) & (adv >= SCAN_ADV)]
    scannable = [s for s in scannable if s in sector_of]
    by_adv = adv.loc[scannable].sort_values(ascending=False)
    top_sector_members = [s for s in by_adv.index if sector_of[s] in top_sectors][:SCAN_TOP_SECTOR_CAP]
    broad = list(by_adv.head(SCAN_BROAD_CAP).index)
    scan_universe = list(dict.fromkeys(top_sector_members + broad + candidates))

    penny_ok = adv.index[(last > 0) & (last <= PENNY_MAX_PRICE) & (adv >= PENNY_ADV)]
    penny_universe = list(adv.loc[penny_ok].sort_values(ascending=False).head(PENNY_CAP).index)

    out = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "top_sectors": top_sectors,
        "sector_momentum_pct": {k: round(float(v), 2) for k, v in sec_mom.items()},
        "sector_of": {s: sector_of[s] for s in symbols if s in sector_of},
        "candidates": candidates,
        "scan_universe": scan_universe,
        "penny_universe": penny_universe,
    }
    OUT_FILE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"[sector-gate] top sectors: {top_sectors}")
    print(f"[sector-gate] {len(candidates)} candidates: {candidates[:15]} ...")
    print(f"[sector-gate] scan universe: {len(scan_universe)} · penny universe: {len(penny_universe)}")
    print(f"[sector-gate] wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
