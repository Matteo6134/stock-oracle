import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function verifyCandidates() {
  const symbols = ['LCID', 'ENVX', 'MVIS', 'CAR', 'LEGN', 'ERAS', 'MXL', 'KYTX'];
  console.log(`Verifying ${symbols.length} candidates for Short Squeeze potential...\n`);
  
  const results = await Promise.allSettled(symbols.map(async (s) => {
    const summary = await yf.quoteSummary(s, {
      modules: ['defaultKeyStatistics', 'price', 'summaryDetail'],
    });
    return { symbol: s, summary };
  }));

  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const { symbol, summary } = r.value;
      const stats = summary.defaultKeyStatistics;
      const price = summary.price;
      
      const si = stats?.shortPercentOfFloat?.raw * 100 || stats?.shortPercentOfFloat * 100 || 0;
      const dtc = stats?.shortRatio?.raw || stats?.shortRatio || 0;
      const lastPrice = price?.regularMarketPrice?.raw || price?.regularMarketPrice || 0;
      const change = price?.regularMarketChangePercent?.raw * 100 || price?.regularMarketChangePercent || 0;

      console.log(`${symbol}: Price=$${lastPrice.toFixed(2)} (${change.toFixed(2)}%), SI=${si.toFixed(2)}%, DTC=${dtc.toFixed(2)}`);
      
      if (si > 20 && dtc > 5) {
          console.log(`   -> CRITICAL SQUEEZE ZONE`);
      } else if (si > 15 || dtc > 4) {
          console.log(`   -> SQUEEZE WATCH`);
      }
    } else {
        console.log(`Failed to fetch data for a symbol: ${r.reason}`);
    }
  });
}

verifyCandidates();
