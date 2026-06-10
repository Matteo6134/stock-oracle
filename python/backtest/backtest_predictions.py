"""
Signal Attribution from Supabase Predictions
=============================================
Pulls all resolved predictions, parses the signals encoded in the `thesis` field,
and computes per-signal hit rate, average return, and profit factor.

Outputs:
  - human-readable table to stdout
  - JSON report at signal_attribution.json
  - re-fit weight table compatible with server/services/signalLearner.js

Run:
  python backtest_predictions.py [--min-samples 5] [--out signal_attribution.json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"

SIG_RX = re.compile(r"\[SIG:([^\]]+)\]")
PRED_RX = re.compile(r"\[PRED:\+?([0-9.]+)%/(\d+)d/([0-9.]+)%/([^\]]+)\]")


def load_env(path: Path) -> dict:
    """Tiny dotenv loader — avoids extra dep."""
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def fetch_resolved_predictions(url: str, key: str) -> list[dict]:
    """Pulls all predictions with non-null outcomes."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows: list[dict] = []
    offset = 0
    page = 1000
    while True:
        r = requests.get(
            f"{url}/rest/v1/predictions",
            params={
                "select": "id,symbol,target_pct,actual_pct,outcome,gem_score,consensus,timeframe_days,thesis,created_at,settled_at",
                "outcome": "not.is.null",
                "order": "settled_at.asc",
                "limit": page,
                "offset": offset,
            },
            headers=headers,
            timeout=15,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def parse_signals(thesis: str) -> list[str]:
    if not thesis:
        return []
    m = SIG_RX.search(thesis)
    if not m:
        return []
    return [s.strip() for s in m.group(1).split(",") if s.strip()]


@dataclass
class SignalStats:
    name: str
    count: int = 0
    wins: int = 0          # outcome == 'win' (hit >=50% of target)
    partials: int = 0      # outcome == 'partial' (positive but missed target)
    losses: int = 0        # outcome == 'loss'
    total_return: float = 0.0
    return_when_present: list[float] = field(default_factory=list)
    sum_pos_returns: float = 0.0
    sum_neg_returns: float = 0.0
    by_consensus: dict = field(default_factory=lambda: defaultdict(int))

    def update(self, row: dict):
        self.count += 1
        outcome = row.get("outcome")
        if outcome == "win":
            self.wins += 1
        elif outcome == "partial":
            self.partials += 1
        elif outcome == "loss":
            self.losses += 1
        actual = float(row.get("actual_pct") or 0.0)
        self.total_return += actual
        self.return_when_present.append(actual)
        if actual > 0:
            self.sum_pos_returns += actual
        elif actual < 0:
            self.sum_neg_returns += abs(actual)
        cons = row.get("consensus") or "Unknown"
        self.by_consensus[cons] += 1

    @property
    def hit_rate(self) -> float:
        return (self.wins + self.partials) / self.count if self.count else 0.0

    @property
    def strict_win_rate(self) -> float:
        return self.wins / self.count if self.count else 0.0

    @property
    def avg_return(self) -> float:
        return self.total_return / self.count if self.count else 0.0

    @property
    def profit_factor(self) -> float:
        if self.sum_neg_returns <= 0:
            return float("inf") if self.sum_pos_returns > 0 else 0.0
        return self.sum_pos_returns / self.sum_neg_returns

    @property
    def median_return(self) -> float:
        if not self.return_when_present:
            return 0.0
        s = sorted(self.return_when_present)
        n = len(s)
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def fit_learned_weight(stats: SignalStats, default: float = 10.0) -> float:
    """
    Mirrors signalLearner.js formula:
      confidence = min(1, count/20)
      raw = (hit10Rate × 30) + (winRate × 10) + max(0, avgMaxGain) × 0.5
      learnedWeight = round(raw × confidence × 100) / 100
    Loser penalty: if winRate<30 && avgRet<-3, learnedWeight += round(avgRet)
    """
    if stats.count < 5:
        return default
    confidence = min(1.0, stats.count / 20.0)
    hit10_rate = stats.hit_rate
    win_rate = stats.strict_win_rate
    avg_max_gain = max(0.0, stats.avg_return)
    raw = (hit10_rate * 30.0) + (win_rate * 10.0) + (avg_max_gain * 0.5)
    learned = round(raw * confidence * 100.0) / 100.0
    if win_rate < 0.3 and stats.avg_return < -3:
        learned += round(stats.avg_return)
    return max(0.0, learned)


def compute_combos(rows: list[dict], min_count: int = 3) -> list[dict]:
    """All signal pairs and their combined hit rate."""
    combo_stats: dict[tuple[str, str], SignalStats] = {}
    for row in rows:
        sigs = sorted(set(parse_signals(row.get("thesis", ""))))
        for pair in combinations(sigs, 2):
            stats = combo_stats.setdefault(pair, SignalStats(name=f"{pair[0]} + {pair[1]}"))
            stats.update(row)

    out = []
    for pair, s in combo_stats.items():
        if s.count < min_count:
            continue
        out.append({
            "pair": list(pair),
            "count": s.count,
            "hit_rate": round(s.hit_rate, 3),
            "strict_win_rate": round(s.strict_win_rate, 3),
            "avg_return_pct": round(s.avg_return, 3),
            "profit_factor": round(s.profit_factor, 3) if s.profit_factor != float("inf") else None,
        })
    out.sort(key=lambda x: -x["hit_rate"])
    return out


def overall_stats(rows: list[dict]) -> dict:
    from collections import Counter
    c = Counter(r["outcome"] for r in rows)
    n = len(rows)
    if not n:
        return {"n": 0}
    total_return = sum(float(r.get("actual_pct") or 0) for r in rows)
    pos = [float(r["actual_pct"]) for r in rows if (r.get("actual_pct") or 0) > 0]
    neg = [float(r["actual_pct"]) for r in rows if (r.get("actual_pct") or 0) < 0]
    pf = (sum(pos) / abs(sum(neg))) if neg else float("inf")
    return {
        "n": n,
        "wins": c.get("win", 0),
        "partials": c.get("partial", 0),
        "losses": c.get("loss", 0),
        "win_rate_strict": round(c.get("win", 0) / n, 3),
        "hit_rate_50pct_target": round((c.get("win", 0) + c.get("partial", 0)) / n, 3),
        "positive_return_rate": round(sum(1 for r in rows if (r.get("actual_pct") or 0) > 0) / n, 3),
        "avg_return_pct": round(total_return / n, 3),
        "median_return_pct": round(sorted(float(r.get("actual_pct") or 0) for r in rows)[n // 2], 3),
        "best_return_pct": round(max(float(r.get("actual_pct") or 0) for r in rows), 3),
        "worst_return_pct": round(min(float(r.get("actual_pct") or 0) for r in rows), 3),
        "profit_factor": round(pf, 3) if pf != float("inf") else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-samples", type=int, default=5)
    ap.add_argument("--out", default=str(Path(__file__).parent / "signal_attribution.json"))
    args = ap.parse_args()

    env = load_env(ENV_FILE)
    url = env.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = env.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        print("ERROR: set SUPABASE_URL / SUPABASE_ANON_KEY in .env", file=sys.stderr)
        sys.exit(2)

    print(f"[backtest] Fetching resolved predictions from {url}")
    rows = fetch_resolved_predictions(url, key)
    print(f"[backtest] {len(rows)} resolved predictions")
    if not rows:
        sys.exit(0)

    overall = overall_stats(rows)
    print("\n=== OVERALL ===")
    for k, v in overall.items():
        print(f"  {k:30s} {v}")

    sig_stats: dict[str, SignalStats] = {}
    for row in rows:
        for sig in set(parse_signals(row.get("thesis", ""))):
            stats = sig_stats.setdefault(sig, SignalStats(name=sig))
            stats.update(row)

    sig_table = []
    for name, s in sorted(sig_stats.items(), key=lambda kv: -kv[1].count):
        if s.count < args.min_samples:
            continue
        sig_table.append({
            "signal": name,
            "count": s.count,
            "hit_rate": round(s.hit_rate, 3),
            "win_rate_strict": round(s.strict_win_rate, 3),
            "avg_return_pct": round(s.avg_return, 3),
            "median_return_pct": round(s.median_return, 3),
            "profit_factor": (round(s.profit_factor, 3) if s.profit_factor != float("inf") else None),
            "fitted_weight": fit_learned_weight(s),
        })

    print("\n=== PER-SIGNAL ===")
    print(f"{'signal':32s} {'n':>4s} {'hit%':>6s} {'win%':>6s} {'avgR%':>7s} {'PF':>6s} {'wt':>6s}")
    for row in sig_table:
        pf = f"{row['profit_factor']:.2f}" if row["profit_factor"] is not None else "  inf"
        print(f"{row['signal']:32s} {row['count']:>4d} "
              f"{row['hit_rate']*100:>5.1f}% {row['win_rate_strict']*100:>5.1f}% "
              f"{row['avg_return_pct']:>6.2f}% {pf:>6s} {row['fitted_weight']:>5.1f}")

    combos = compute_combos(rows, min_count=3)
    print(f"\n=== TOP 15 COMBOS (count>=3) ===")
    for c in combos[:15]:
        pf = f"{c['profit_factor']:.2f}" if c["profit_factor"] is not None else "inf"
        print(f"  {c['hit_rate']*100:>5.1f}% hit | {c['avg_return_pct']:>6.2f}% avg | "
              f"PF {pf:>5s} | n={c['count']:>3d} | {c['pair'][0]} + {c['pair'][1]}")

    by_score_bucket: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        gs = r.get("gem_score") or 0
        bucket = (
            "0-49" if gs < 50 else
            "50-59" if gs < 60 else
            "60-69" if gs < 70 else
            "70-79" if gs < 80 else
            "80+"
        )
        by_score_bucket[bucket].append(float(r.get("actual_pct") or 0))

    print(f"\n=== BY GEM_SCORE BUCKET ===")
    for bucket in ["0-49", "50-59", "60-69", "70-79", "80+"]:
        rets = by_score_bucket.get(bucket, [])
        if not rets:
            continue
        avg = sum(rets) / len(rets)
        win_pct = sum(1 for r in rets if r > 0) / len(rets) * 100
        print(f"  {bucket:6s}  n={len(rets):>3d}  avg={avg:>6.2f}%  win%={win_pct:>5.1f}%")

    report = {
        "n_resolved": len(rows),
        "overall": overall,
        "per_signal": sig_table,
        "top_combos": combos[:50],
        "by_gem_score_bucket": {
            b: {
                "n": len(by_score_bucket.get(b, [])),
                "avg_return_pct": round(sum(by_score_bucket.get(b, [])) / max(len(by_score_bucket.get(b, [])), 1), 3),
                "positive_rate": round(sum(1 for r in by_score_bucket.get(b, []) if r > 0) / max(len(by_score_bucket.get(b, [])), 1), 3),
            }
            for b in by_score_bucket
        },
    }
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n[backtest] Wrote report to {args.out}")


if __name__ == "__main__":
    main()
