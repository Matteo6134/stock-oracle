import axios from 'axios';

async function test() {
  const dates = ['2026-03-11', '2026-03-12'];
  for (const dateStr of dates) {
    const url = `https://finance.yahoo.com/calendar/earnings?guccounter=1&day=${dateStr}`;
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const tickerRegex = /"symbol":"([A-Z]{1,5})"/g;
    let match;
    const tickers = [];
    while ((match = tickerRegex.exec(html)) !== null) {
      if (!tickers.includes(match[1])) tickers.push(match[1]);
    }
    console.log(`Date ${dateStr} matches: ${tickers.length}`, tickers.slice(0, 5));
  }
}
test();
