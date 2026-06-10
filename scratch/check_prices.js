import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function getExecutionData() {
  const symbols = ['CAR', 'HTZ', 'FLWS', 'NU', 'SANA'];
  const results = await Promise.allSettled(symbols.map(s => yf.quote(s)));
  
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const q = r.value;
      console.log(`${q.symbol}: Price=$${q.regularMarketPrice}, Volume=${q.regularMarketVolume}, Change=${q.regularMarketChangePercent}%`);
    }
  });
}

getExecutionData();
