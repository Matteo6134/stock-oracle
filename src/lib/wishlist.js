// Wishlist manager — stores in localStorage + syncs to server for Telegram

const KEY = 'stock_wishlist'
const API = import.meta.env.VITE_API_URL || ''

export function getWishlist() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

export function addToWishlist(symbol) {
  const sym = symbol.toUpperCase().trim()
  const list = getWishlist()
  if (list.includes(sym)) return list
  const updated = [...list, sym]
  localStorage.setItem(KEY, JSON.stringify(updated))
  // Sync to server (fire & forget)
  fetch(`${API}/api/watchlist/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: sym }),
  }).catch(() => {})
  return updated
}

export function removeFromWishlist(symbol) {
  const sym = symbol.toUpperCase().trim()
  const updated = getWishlist().filter(s => s !== sym)
  localStorage.setItem(KEY, JSON.stringify(updated))
  // Sync to server (fire & forget)
  fetch(`${API}/api/watchlist/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: sym }),
  }).catch(() => {})
  return updated
}

export function isInWishlist(symbol) {
  return getWishlist().includes(symbol.toUpperCase().trim())
}

// Sync full list to server (call on app load)
export function syncWatchlistToServer() {
  const list = getWishlist()
  if (list.length > 0) {
    fetch(`${API}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: list }),
    }).catch(() => {})
  }
}
