// Wishlist manager — stores user's custom watchlist in localStorage

const KEY = 'stock_wishlist'

export function getWishlist() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

export function addToWishlist(symbol) {
  const sym = symbol.toUpperCase().trim()
  const list = getWishlist()
  if (list.includes(sym)) return list
  const updated = [...list, sym]
  localStorage.setItem(KEY, JSON.stringify(updated))
  return updated
}

export function removeFromWishlist(symbol) {
  const sym = symbol.toUpperCase().trim()
  const updated = getWishlist().filter(s => s !== sym)
  localStorage.setItem(KEY, JSON.stringify(updated))
  return updated
}

export function isInWishlist(symbol) {
  return getWishlist().includes(symbol.toUpperCase().trim())
}
