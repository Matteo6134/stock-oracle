# Wiring the Daily Picker — when you're ready

The picker is built but **not yet wired into the running bot**. Two-step rollout:

## Step 1 — Manual / Telegram-only (zero risk, recommended first 2 weeks)

Add this to `server/index.js` near the other crons (after the `*/5` gem scan block at line ~239):

```js
import { runDailyPicker } from './services/dailyPicker.js';
import { sendTelegramMessage } from './services/telegram.js';   // adjust to actual exported name

// Daily pick — runs at 16:05 ET (after market close), Mon-Fri only
cron.schedule('5 16 * * 1-5', async () => {
  try {
    await runDailyPicker({
      autoTrade: false,                     // alerts only — no orders submitted
      telegramNotifier: sendTelegramMessage,
    });
  } catch (err) {
    console.error('[DailyPicker] error:', err.message);
  }
}, { timezone: 'America/New_York' });
```

Restart: `pm2 restart stock-oracle --update-env`

For the first 2 weeks, the bot will Telegram you tomorrow's pick at 16:05 ET. You decide whether to trade it manually. Track every pick's outcome in `server/data/dailyPicks.json`.

## Step 2 — Validate against monkey baseline

After ≥20 picks (≈4 weeks):

```bash
cd python/monkey
python -m pip install -r requirements.txt
python monkey_baseline.py
```

Read the verdict. If <75th percentile → **don't enable autoTrade**. Iterate the ranking formula in `compositeScore` (`dailyPicker.js`) and try again.

## Step 3 — Auto-trade (only after monkey-pass)

Once monkey baseline is consistently ≥75th percentile across 2+ months, change the cron to:

```js
await runDailyPicker({
  autoTrade: process.env.AUTO_DAILY_PICK === 'true',
  dollarAmount: 500,                       // start small
  telegramNotifier: sendTelegramMessage,
});
```

Set `AUTO_DAILY_PICK=true` in `.env` and `pm2 restart stock-oracle --update-env`.

The picker will submit:
- **MOO** (Market-on-Open) buy order — fills at next session's opening auction
- **MOC** (Market-on-Close) sell order — fills at next session's closing auction

**Constraints**:
- Alpaca rejects MOO submitted after 9:28 ET → cron at 16:05 ET is safe
- Alpaca rejects MOC submitted after 15:50 ET → submitted same evening as MOO, so safe
- **PDT rule**: under $25k account equity, you get only 3 day trades / 5-day rolling. Stock-oracle account `PA39AL3DKA9R` has $1,127 equity → will hit PDT lockout fast. Either:
  - Use a separate ≥$25k account for the daily picker
  - Or limit autoTrade to ≤3 trades per 5 days (manual gating)

## Files

- `server/services/dailyPicker.js` — picker service (290 LOC, additive only)
- `server/data/dailyPicks.json` — pick history, auto-created on first run
- `python/monkey/monkey_baseline.py` — validation harness
- `python/monkey/universe.json` — 262-symbol universe snapshot

## Don't

- Don't enable `autoTrade` before monkey-pass. The point of the baseline is to stop you from burning capital on a model that hasn't proven edge.
- Don't tune `compositeScore` weights based on the same picks you're validating against. That's lookahead bias. Tune on weeks 1-4, validate on weeks 5-8.
- Don't increase `dollarAmount` until 2+ months of monkey-pass. Quarter Kelly only after edge is proven.
