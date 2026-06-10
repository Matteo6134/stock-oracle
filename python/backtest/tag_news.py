"""
News Tagger — attaches news context to resolved predictions.
============================================================
For each resolved prediction in Supabase, fetches news headlines around the
prediction date (-2 .. 0 days), runs lightweight sentiment scoring, and writes
back a `news_context` JSON aggregate.

HONEST LIMITATIONS:
  - Yahoo's per-ticker news endpoint typically returns only the most recent
    ~20 articles. Predictions older than ~2 weeks may have empty news context.
  - For real point-in-time news you need a historical archive (NewsAPI paid,
    Bloomberg, Refinitiv). This script gets you the "going forward" answer:
    every NEW prediction from now on will be cleanly tagged.
  - Sentiment uses VADER if installed, else a tiny lexicon — directionally
    correct but not better than +/- 60% accuracy on financial headlines.

Output:
  - Updates Supabase predictions.news_context per row (if column exists; falls
    back to printing report-only mode)
  - JSON report at news_attribution.json with hit-rate breakdown by news regime

Run:
  python tag_news.py [--dry-run] [--max-rows 200] [--lookback-days 2]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
REPORT_FILE = Path(__file__).parent / "news_attribution.json"

# ─── Sentiment ───────────────────────────────────────────────────────────────
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _vader = SentimentIntensityAnalyzer()
    def sentiment(text: str) -> float:
        if not text:
            return 0.0
        return _vader.polarity_scores(text)["compound"]
except ImportError:
    POS = {"beat", "beats", "surge", "soar", "rally", "upgrade", "buy", "outperform",
           "strong", "record", "growth", "wins", "deal", "partnership", "approves",
           "approved", "breakthrough", "exceeds", "raises", "raise", "boost"}
    NEG = {"miss", "misses", "plunge", "tumble", "fall", "downgrade", "sell", "underperform",
           "weak", "loss", "losses", "decline", "fraud", "lawsuit", "investigation",
           "warns", "warning", "cut", "cuts", "sec", "halts", "halted", "delisted"}
    def sentiment(text: str) -> float:
        if not text:
            return 0.0
        words = set(w.lower().strip(".,!?\"'") for w in text.split())
        pos, neg = len(words & POS), len(words & NEG)
        total = pos + neg
        return 0.0 if total == 0 else (pos - neg) / total


# ─── Env loader ──────────────────────────────────────────────────────────────
def load_env(path: Path) -> dict:
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


# ─── Supabase ────────────────────────────────────────────────────────────────
def fetch_resolved(url: str, key: str, max_rows: int) -> list[dict]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows: list[dict] = []
    offset = 0
    page = 1000
    while len(rows) < max_rows:
        r = requests.get(
            f"{url}/rest/v1/predictions",
            params={
                "select": "id,symbol,created_at,actual_pct,outcome,news_context",
                "outcome": "not.is.null",
                "order": "created_at.desc",
                "limit": min(page, max_rows - len(rows)),
                "offset": offset,
            },
            headers=headers, timeout=15,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def update_news_context(url: str, key: str, pred_id: int, ctx: dict) -> bool:
    headers = {
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }
    r = requests.patch(
        f"{url}/rest/v1/predictions",
        params={"id": f"eq.{pred_id}"},
        headers=headers,
        json={"news_context": ctx},
        timeout=10,
    )
    if r.status_code == 204:
        return True
    if r.status_code == 400 and "news_context" in r.text:
        return False         # column likely missing
    print(f"  WARN: PATCH id={pred_id} → {r.status_code} {r.text[:120]}", file=sys.stderr)
    return False


# ─── News fetcher ────────────────────────────────────────────────────────────
def fetch_news(symbol: str, around_date: datetime, lookback_days: int) -> list[dict]:
    """Returns list of {title, publisher, link, published_at, sentiment} for items
    within [around_date - lookback_days, around_date]."""
    try:
        t = yf.Ticker(symbol)
        items = t.news or []
    except Exception:
        return []

    lo = around_date - timedelta(days=lookback_days)
    hi = around_date + timedelta(hours=12)
    out = []
    for it in items:
        # yfinance schema can be `providerPublishTime` (epoch s) or nested under `content`
        ts = it.get("providerPublishTime")
        title = it.get("title")
        publisher = it.get("publisher", "")
        link = it.get("link", "")
        if ts is None and isinstance(it.get("content"), dict):
            c = it["content"]
            title = title or c.get("title")
            publisher = publisher or c.get("provider", {}).get("displayName", "")
            link = link or c.get("canonicalUrl", {}).get("url", "")
            pub_str = c.get("pubDate") or c.get("displayTime")
            if pub_str:
                try:
                    ts = int(datetime.fromisoformat(pub_str.replace("Z", "+00:00")).timestamp())
                except ValueError:
                    ts = None
        if ts is None or not title:
            continue
        published = datetime.fromtimestamp(ts, tz=timezone.utc)
        if not (lo <= published <= hi):
            continue
        out.append({
            "title": title,
            "publisher": publisher,
            "link": link,
            "published_at": published.isoformat(),
            "sentiment": round(sentiment(title), 3),
        })
    return out


# ─── Aggregation ─────────────────────────────────────────────────────────────
EARNINGS_KEYWORDS = ("earnings", "q1", "q2", "q3", "q4", "quarter", "eps", "revenue",
                     "beat", "miss", "guidance", "outlook")
ANALYST_KEYWORDS = ("upgrade", "downgrade", "target", "rating", "buy", "sell", "hold",
                    "outperform", "underperform")
DEAL_KEYWORDS = ("acquires", "acquisition", "merger", "merges", "buyout", "deal", "stake",
                 "partnership", "agreement")
LEGAL_KEYWORDS = ("lawsuit", "investigation", "fraud", "sec", "halts", "halted", "delisted",
                  "subpoena", "probe")


def categorize(news: list[dict]) -> dict:
    """Bucketize a news bundle into thematic flags."""
    flags = Counter()
    for it in news:
        title = (it.get("title") or "").lower()
        if any(k in title for k in EARNINGS_KEYWORDS):
            flags["earnings"] += 1
        if any(k in title for k in ANALYST_KEYWORDS):
            flags["analyst"] += 1
        if any(k in title for k in DEAL_KEYWORDS):
            flags["deal"] += 1
        if any(k in title for k in LEGAL_KEYWORDS):
            flags["legal"] += 1
    return dict(flags)


def aggregate(news: list[dict]) -> dict:
    if not news:
        return {"count": 0}
    sents = [n["sentiment"] for n in news]
    pos = sum(1 for s in sents if s > 0.1)
    neg = sum(1 for s in sents if s < -0.1)
    avg = round(sum(sents) / len(sents), 3)
    return {
        "count": len(news),
        "avg_sentiment": avg,
        "positive": pos,
        "negative": neg,
        "neutral": len(news) - pos - neg,
        "regime": "bullish" if avg > 0.15 else "bearish" if avg < -0.15 else "neutral",
        "categories": categorize(news),
        "top_headlines": [n["title"] for n in sorted(news, key=lambda x: -abs(x["sentiment"]))[:3]],
    }


# ─── Attribution ─────────────────────────────────────────────────────────────
def attribute(rows: list[dict]) -> dict:
    """Aggregate hit-rate by news regime / category."""
    by_regime = defaultdict(list)
    by_category = defaultdict(list)
    for r in rows:
        ctx = r.get("news_context") or {}
        actual = float(r.get("actual_pct") or 0.0)
        regime = ctx.get("regime", "no_news")
        by_regime[regime].append(actual)
        for cat in (ctx.get("categories") or {}):
            by_category[cat].append(actual)

    def stats(arr):
        if not arr:
            return None
        n = len(arr)
        wins = sum(1 for a in arr if a > 0)
        return {
            "count": n,
            "win_rate": round(wins / n, 3),
            "avg_return_pct": round(sum(arr) / n, 3),
            "median_return_pct": round(sorted(arr)[n // 2], 3),
        }

    return {
        "by_news_regime": {k: stats(v) for k, v in by_regime.items()},
        "by_category_present": {k: stats(v) for k, v in by_category.items()},
    }


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Don't write back to Supabase")
    ap.add_argument("--max-rows", type=int, default=300)
    ap.add_argument("--lookback-days", type=int, default=2)
    ap.add_argument("--rate-limit-ms", type=int, default=300, help="Delay between symbols")
    ap.add_argument("--out", default=str(REPORT_FILE))
    args = ap.parse_args()

    env = load_env(ENV_FILE)
    url = env.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = env.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_URL / SUPABASE_ANON_KEY missing", file=sys.stderr)
        sys.exit(2)

    print(f"[news] fetching up to {args.max_rows} resolved predictions ...")
    rows = fetch_resolved(url, key, args.max_rows)
    print(f"[news] got {len(rows)} rows")

    column_present = True
    tagged = 0
    skipped_no_news = 0
    out_rows = []
    for i, row in enumerate(rows):
        if row.get("news_context") and not args.dry_run:
            out_rows.append(row)
            continue
        try:
            created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        news = fetch_news(row["symbol"], created, args.lookback_days)
        ctx = aggregate(news)
        row["news_context"] = ctx
        if ctx["count"] == 0:
            skipped_no_news += 1
        else:
            tagged += 1

        if not args.dry_run and column_present:
            ok = update_news_context(url, key, row["id"], ctx)
            if not ok and not column_present:
                pass
            elif not ok:
                # First failure → likely column missing; switch to report-only
                if i == 0:
                    print("[news] news_context column missing on predictions table — running in report-only mode")
                    column_present = False

        out_rows.append(row)
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{len(rows)}] tagged={tagged} no_news={skipped_no_news}")
        time.sleep(args.rate_limit_ms / 1000.0)

    print(f"\n[news] tagged {tagged}, no news for {skipped_no_news} of {len(rows)}")

    print("\n=== ATTRIBUTION ===")
    attr = attribute(out_rows)
    print("\nBy news regime:")
    for regime, s in attr["by_news_regime"].items():
        if not s:
            continue
        print(f"  {regime:10s} n={s['count']:>3d}  win%={s['win_rate']*100:>5.1f}  avg={s['avg_return_pct']:>6.2f}%  med={s['median_return_pct']:>6.2f}%")
    print("\nBy category presence:")
    for cat, s in attr["by_category_present"].items():
        if not s:
            continue
        print(f"  {cat:10s} n={s['count']:>3d}  win%={s['win_rate']*100:>5.1f}  avg={s['avg_return_pct']:>6.2f}%  med={s['median_return_pct']:>6.2f}%")

    Path(args.out).write_text(json.dumps({
        "n_predictions": len(rows),
        "n_tagged": tagged,
        "n_no_news": skipped_no_news,
        "column_writeable": column_present and not args.dry_run,
        "attribution": attr,
    }, indent=2), encoding="utf-8")
    print(f"\n[news] wrote {args.out}")


if __name__ == "__main__":
    main()
