"""
Monkey Baseline — the only honest validation for the daily picker.

What it does:
  1. Reads dailyPicks.json (the bot's actual picks)
  2. Reads each pick's actual realized open-to-close return from Yahoo Finance
  3. Simulates 10,000 dart-throwing monkeys picking randomly from the same universe on the same days
  4. Reports the bot's percentile vs the monkey distribution

Pass criterion (per the lstm-trading-v2 skill):
  - >75th percentile sustained across multiple windows = real edge
  - 50-90th percentile = probably noise
  - <50th percentile = kill the model

Run weekly:
    python monkey_baseline.py

Or via PM2 cron (one-shot):
    pm2 start monkey_baseline.py --no-autorestart --cron "0 18 * * 5" --name monkey-weekly
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
PICKS_FILE = ROOT / "server" / "data" / "dailyPicks.json"
UNIVERSE_FILE = Path(__file__).parent / "universe.json"

DEFAULT_N_MONKEYS = 10_000
DEFAULT_SEED = 42


@dataclass
class PickResult:
    pick_date: str
    symbol: str
    actual_return_pct: float | None
    bot_composite_score: float


def load_picks(picks_file: Path) -> list[dict]:
    if not picks_file.exists():
        print(f"[monkey] No picks file at {picks_file} — bot hasn't picked yet")
        return []
    with picks_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_universe(universe_file: Path) -> list[str]:
    """Universe must match what the bot was choosing from. Mirror STOCK_UNIVERSE
    from server/services/premarketScanner.js exactly. If file missing, fall back
    to a small default so the script still runs."""
    if universe_file.exists():
        with universe_file.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("symbols", [])
    print(f"[monkey] WARNING: {universe_file} missing — using small default universe")
    return [
        "NVDA", "AMD", "TSLA", "AAPL", "MSFT", "GOOGL", "META", "AMZN",
        "PLTR", "SOFI", "MARA", "RIOT", "COIN", "GME", "AMC", "BBBY",
        "TQQQ", "SQQQ", "QQQ", "SPY",
    ]


def fetch_open_to_close_return(symbol: str, date_iso: str) -> float | None:
    """Returns realized open-to-close return % for symbol on date_iso, or None
    if the day didn't trade (weekend/holiday) or data unavailable."""
    try:
        d = datetime.fromisoformat(date_iso).date()
        # yfinance is half-open: end must be the day AFTER the target
        df = yf.Ticker(symbol).history(
            start=d.isoformat(),
            end=(d + timedelta(days=1)).isoformat(),
            interval="1d",
            auto_adjust=False,
        )
        if df.empty:
            return None
        row = df.iloc[0]
        open_p, close_p = float(row["Open"]), float(row["Close"])
        if open_p <= 0:
            return None
        return (close_p - open_p) / open_p * 100.0
    except Exception as exc:                                      # noqa: BLE001
        print(f"[monkey] fetch error {symbol} {date_iso}: {exc}", file=sys.stderr)
        return None


def fetch_universe_returns_for_dates(universe: list[str], dates: list[str]) -> pd.DataFrame:
    """Fetches O2C returns for the entire universe on each pick date.
    Returns DataFrame[rows=dates, cols=symbols] of pct returns."""
    if not dates:
        return pd.DataFrame()
    start = min(dates)
    end_dt = datetime.fromisoformat(max(dates)).date() + timedelta(days=1)
    print(f"[monkey] Downloading {len(universe)} symbols, {start}..{end_dt.isoformat()}")
    bulk = yf.download(
        tickers=universe,
        start=start,
        end=end_dt.isoformat(),
        interval="1d",
        auto_adjust=False,
        group_by="ticker",
        progress=False,
        threads=True,
    )
    rows: dict[str, dict[str, float]] = {d: {} for d in dates}
    for sym in universe:
        try:
            sub = bulk[sym] if sym in bulk.columns.levels[0] else None
        except (AttributeError, KeyError):
            sub = None
        if sub is None or sub.empty:
            continue
        for d in dates:
            if d not in [x.strftime("%Y-%m-%d") for x in sub.index]:
                continue
            day_row = sub.loc[d]
            o, c = float(day_row.get("Open", 0)), float(day_row.get("Close", 0))
            if o > 0:
                rows[d][sym] = (c - o) / o * 100.0
    return pd.DataFrame.from_dict(rows, orient="index").fillna(0)


def simulate_monkeys(
    returns_panel: pd.DataFrame,
    n_monkeys: int = DEFAULT_N_MONKEYS,
    seed: int = DEFAULT_SEED,
) -> np.ndarray:
    """For each monkey, pick one random symbol per day, sum daily returns
    (treating each pick as a fresh trade — open at open, close at close, no compounding).
    Returns array shape (n_monkeys,) of TOTAL summed returns across the period."""
    if returns_panel.empty:
        return np.array([])
    rng = np.random.default_rng(seed)
    n_days, n_syms = returns_panel.shape
    if n_syms == 0:
        return np.array([])
    picks = rng.integers(0, n_syms, size=(n_monkeys, n_days))
    daily_rets = np.zeros((n_monkeys, n_days))
    panel = returns_panel.values                          # (n_days, n_syms)
    for d in range(n_days):
        daily_rets[:, d] = panel[d, picks[:, d]]
    return daily_rets.sum(axis=1)


def evaluate(picks: list[dict], universe: list[str], n_monkeys: int) -> dict:
    if not picks:
        return {"error": "no picks"}

    pick_dates = sorted({p["pickDate"] for p in picks})
    pick_by_date = {p["pickDate"]: p for p in picks}      # last write wins per date

    # Bot's actual returns
    bot_returns: list[PickResult] = []
    for d in pick_dates:
        pk = pick_by_date[d]
        ret = fetch_open_to_close_return(pk["symbol"], d)
        bot_returns.append(PickResult(
            pick_date=d,
            symbol=pk["symbol"],
            actual_return_pct=ret,
            bot_composite_score=float(pk.get("compositeScore", 0)),
        ))
    valid_bot = [r for r in bot_returns if r.actual_return_pct is not None]
    bot_total = sum(r.actual_return_pct for r in valid_bot)

    # Monkey simulation on the SAME days, SAME universe
    panel = fetch_universe_returns_for_dates(universe, [r.pick_date for r in valid_bot])
    monkey_totals = simulate_monkeys(panel, n_monkeys=n_monkeys)

    if monkey_totals.size == 0:
        return {"error": "monkey simulation produced no data — universe fetch failed"}

    percentile = float((monkey_totals < bot_total).sum()) / len(monkey_totals) * 100.0
    return {
        "n_picks_evaluated": len(valid_bot),
        "n_picks_total": len(pick_dates),
        "bot_total_return_pct": round(bot_total, 3),
        "bot_avg_return_per_day_pct": round(bot_total / max(len(valid_bot), 1), 3),
        "monkey_n": int(monkey_totals.size),
        "monkey_mean_pct": round(float(np.mean(monkey_totals)), 3),
        "monkey_median_pct": round(float(np.median(monkey_totals)), 3),
        "monkey_p5_pct": round(float(np.percentile(monkey_totals, 5)), 3),
        "monkey_p95_pct": round(float(np.percentile(monkey_totals, 95)), 3),
        "bot_percentile_vs_monkeys": round(percentile, 1),
        "verdict": _verdict(percentile, len(valid_bot)),
        "per_pick": [
            {"date": r.pick_date, "symbol": r.symbol, "return_pct": round(r.actual_return_pct, 3) if r.actual_return_pct is not None else None}
            for r in bot_returns
        ],
    }


def _verdict(percentile: float, n_picks: int) -> str:
    if n_picks < 20:
        return f"INSUFFICIENT_DATA (need ≥20 picks, have {n_picks}) — keep collecting"
    if percentile < 50:
        return "FAIL — bot below median monkey, kill or rebuild"
    if percentile < 75:
        return "PROBABLY_NOISE — between 50th and 75th percentile, no edge proven"
    if percentile < 95:
        return "PROMISING — above 75th, keep paper trading"
    return "STRONG — >95th percentile, candidate for live capital (with quarter Kelly)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--picks", default=str(PICKS_FILE), help="Path to dailyPicks.json")
    ap.add_argument("--universe", default=str(UNIVERSE_FILE), help="Path to universe.json")
    ap.add_argument("--monkeys", type=int, default=DEFAULT_N_MONKEYS)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--out", default=None, help="Optional path to write JSON report")
    args = ap.parse_args()

    picks = load_picks(Path(args.picks))
    universe = load_universe(Path(args.universe))

    print(f"[monkey] {len(picks)} picks, {len(universe)} universe symbols, {args.monkeys} monkeys")
    result = evaluate(picks, universe, args.monkeys)
    print(json.dumps(result, indent=2))

    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"[monkey] Wrote report to {args.out}")


if __name__ == "__main__":
    main()
