---
name: trading-bots-ops
description: Operate Matteo's local trading bot (stock-oracle Node bot at C:/Users/pc2/Desktop/binance-bot). Use when the user asks to start/stop/restart the bot, check if Telegram bot @StockOracle2_bot is online, troubleshoot why trades aren't firing, inspect data sources, or when they mention "the bot", "stock oracle", "alpaca", or PM2 in this context.
---

# Trading Bots — Local Ops

ONE trading bot runs under PM2 on this Windows PC. It is NOT deployed to Railway anymore (old `stock-oracle-production-064f.up.railway.app` and `web-production-7dbdc.up.railway.app` are dead — do not check them).

**The gold bot (`alpaca-gold-bot`) was RETIRED on 2026-06-11** — removed from PM2 and `ecosystem.config.cjs`. Its folder still exists at `C:/Users/pc2/Desktop/gold` (inert) and its paper account `PA3T2A47LGRI` is abandoned. Do not restart it unless Matteo asks.

## Topology

| Bot | PM2 name | Path | Stack | Port | Telegram |
|---|---|---|---|---|---|
| Stock scanner + auto-trader | `stock-oracle` | `C:/Users/pc2/Desktop/binance-bot` | Node, `server/index.js` | 4000 | `@StockOracle2_bot` (long-poll inside same process) |

Supervised by PM2. Boot persistence via `pm2-windows-startup` is **already installed** (registry entry added) — survives reboots. Ecosystem file: `C:/Users/pc2/Desktop/binance-bot/ecosystem.config.cjs`.

## Alpaca account

| Bot | Account # | Read keys from |
|---|---|---|
| stock-oracle | `PA3INRBI56WC` — fresh **$4k** paper account since 2026-06-11 (previous: PA39AL3DKA9R, abandoned) | `binance-bot/.env` → `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` / `ALPACA_BASE_URL` |

Paper account at `https://paper-api.alpaca.markets`. Under $25k equity the PDT rule applies (3 day-trades per 5 rolling days) — the bot's pdtGuard handles it. Verify identity with:
```bash
curl -s -H "APCA-API-KEY-ID: $K" -H "APCA-API-SECRET-KEY: $S" https://paper-api.alpaca.markets/v2/account
```

## Standard ops

```bash
pm2 list                                       # status
pm2 restart stock-oracle --update-env          # reload after .env change
pm2 logs stock-oracle --lines 50 --nostream    # recent logs
pm2 save                                       # persist current process list
curl -s http://localhost:4000/health           # stock-oracle health
```

After any change to `ecosystem.config.cjs`: `pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save`.

Logs:
- `C:/Users/pc2/Desktop/binance-bot/logs/{out,error}.log`
- `C:/Users/pc2/Desktop/gold/logs/{out,error}.log`

## Telegram bot health check

The bot runs polling (no webhook). To verify it's reachable independent of PM2:
```bash
source C:/Users/pc2/Desktop/binance-bot/.env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```
- `getMe` returning `StockOracle2_bot` (id `8668346705`) = Telegram side OK.
- Empty `url` in webhook info = polling mode (correct).
- High `pending_update_count` = the bot process is NOT polling → check PM2.

If Telegram looks dead: it's **almost always** that `node server/index.js` isn't running. Check `pm2 list` first, not Telegram.

## Stock-oracle data flows

**Inflows** (`server/services/`):
- Yahoo Finance (`query1/query2.finance.yahoo.com`, lib `yahoo-finance2`) — quotes, charts, fundamentals
- Alpaca (`paper-api.alpaca.markets`, `data.alpaca.markets`) — primary fallback for prices/bars
- Finnhub (`finnhub.io/api/v1`) — analyst/congress/insider/news (needs `FINNHUB_API_KEY`)
- NASDAQ earnings calendar, FINRA RegSHO dark pool, SEC EDGAR
- Reddit, ApeWisdom, StockTwits — social sentiment
- Google News RSS, NewsAPI — news
- Anthropic Claude API — `claudeBrain.js` analysis
- Supabase (`eflmflhtkbzmvuaznxuv.supabase.co`) — predictions/signals reads

**Outflows**:
- Telegram (alerts to `TELEGRAM_CHAT_ID`)
- Alpaca order placement (`autoTrader.js`)
- Supabase (`explosion_predictions`, signal logs)
- Local JSON state in `server/data/*.json` (`agentTrades`, `gemHistory`, `history`, `strategyCalibration`, `signalTracker`, `signalWeights`, `earlyWarningAlertHistory`, `autoTradeConfig`)
- HTTP API on `:4000` + SSE for the React dashboard

**Cron schedule** (`server/index.js`): 15s heartbeat, 2min/3min/5min scans, 5min market-hours scan (08–16 ET Mon–Fri), 10:00 morning job, 17:00 EOD job, weekly calibration Sun 02:00.

## Gold bot specifics

`alpaca_gold_bot.py` uses `pandas_ta` for indicators, manages SL/BE/2R-target on positions, logs every state change to Supabase `market_trade` table.

**PDT rule is active** — Alpaca paper PDT limits to 3 day trades in a 5-day rolling window. When hit, the bot logs `PDT RULE ALERT` and blocks new entries (existing positions still managed). Not a bug.

Tickers it trades: gold/metals/ETF basket (LIT, SLV, GLD, NVDA, QQQ etc — see `config.py` and `alpaca_gold_bot.py`).

## Common diagnoses

| Symptom | Check first |
|---|---|
| "Telegram bot is offline" | `pm2 list` — almost always stock-oracle is stopped |
| Health endpoint returns Next.js 404 HTML | Wrong port. Stock-oracle is on `:4000`. `:3000` is ACQDASH dev server. |
| Gold bot log silent for hours | Normal during PDT lockout or low buying-power; tail `gold/logs/out.log` for last `INFO` line |
| `pm2 list` empty after reboot | `pm2 resurrect` (reads `~/.pm2/dump.pm2`); if persistent, `pm2-startup install` again |
| New trade not firing on stock side | Check `server/data/autoTradeConfig.json` flags + `[AutoTrader]` lines in stock-oracle logs |
| Yahoo validation warnings spam | Known — `yahoo-finance2` v3.13.2 vs latest 3.14.0; non-fatal |

## Don'ts

- Do NOT run `node server/index.js` directly when PM2 already manages it — port 4000 conflict.
- Do NOT add the gold bot's keys to `binance-bot/.env` or vice versa — the separation is intentional.
- Do NOT assume Railway is involved. The repo still has `railway.json` but deployment is dead.
- Do NOT create a webhook for the Telegram bot — it's intentionally polling so it works behind NAT.
- Do NOT kill bare `python.exe` PIDs without checking — could be the gold bot if PM2 lost track. Confirm with `wmic process where "ProcessId=<pid>" get CommandLine`.
