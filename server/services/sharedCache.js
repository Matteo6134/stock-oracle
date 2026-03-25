/**
 * Shared cache between cron jobs (index.js) and API routes (api.js).
 * The cron writes gems/scan results here; the API reads them as fallback
 * when a fresh computation times out (Finnhub rate limits on Railway).
 */
const store = new Map();

export function setShared(key, data) {
  store.set(key, { data, ts: Date.now() });
}

export function getShared(key, maxAgeMs = 10 * 60 * 1000) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.data;
}
