/**
 * Server-side watchlist — synced from web app, readable by Telegram bot
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'watchlist.json');

export function getWatchlist() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return [];
}

export function setWatchlist(symbols) {
  const list = [...new Set(symbols.map(s => s.toUpperCase().trim()).filter(Boolean))];
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

export function addToWatchlist(symbol) {
  const list = getWatchlist();
  const sym = symbol.toUpperCase().trim();
  if (list.includes(sym)) return list;
  list.push(sym);
  return setWatchlist(list);
}

export function removeFromWatchlist(symbol) {
  const list = getWatchlist().filter(s => s !== symbol.toUpperCase().trim());
  return setWatchlist(list);
}
