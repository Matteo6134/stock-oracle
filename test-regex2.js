import fs from 'fs';
const html = fs.readFileSync('yahoo-html.txt', 'utf8');

const tickers = [];
const tickerRegex = /"symbol":"([A-Z]{1,5})"/g;
let match;
while ((match = tickerRegex.exec(html)) !== null) {
  const sym = match[1];
  if (!tickers.includes(sym)) {
    tickers.push(sym);
  }
}
console.log(`Found ${tickers.length} tickers:`, tickers.join(', '));
