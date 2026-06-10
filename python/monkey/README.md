# Monkey Baseline

Validation harness for the daily picker. Compares the bot's actual picks against
10,000 random "monkey" portfolios drawn from the same universe on the same days.

## One-time setup

```bash
cd python/monkey
python -m pip install -r requirements.txt
```

## Run weekly

```bash
python monkey_baseline.py
```

Reads:
- `../../server/data/dailyPicks.json` — written by `dailyPicker.js`
- `universe.json` — snapshotted from `premarketScanner.js STOCK_UNIVERSE.ALL`

Output: JSON report with the bot's percentile vs 10,000 monkeys, and a verdict.

## Refreshing the universe

If you change `STOCK_UNIVERSE` in `premarketScanner.js`, re-snapshot:

```bash
cd ../..
node -e "import('./server/services/premarketScanner.js').then(m => { const u = [...new Set(m.STOCK_UNIVERSE.ALL.map(s => s.toUpperCase()))].sort(); require('fs').writeFileSync('python/monkey/universe.json', JSON.stringify({source:'premarketScanner.js', extractedAt:new Date().toISOString(), count:u.length, symbols:u}, null, 2)); })"
```

## Pass/fail

| Bot percentile | Verdict |
|---|---|
| <50th | FAIL — kill or rebuild |
| 50-75th | NOISE — keep collecting |
| 75-95th | PROMISING — keep paper trading |
| >95th | STRONG — candidate for live capital |

Need ≥20 picks before any verdict is meaningful. Need ≥250 picks (≈1 year) for statistical significance.
