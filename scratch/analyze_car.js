import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function analyzeCARShortSqueeze() {
  const symbol = 'CAR';
  console.log(`Analyzing Short Squeeze potential for ${symbol}...`);
  
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['defaultKeyStatistics', 'price', 'summaryDetail'],
    });

    const stats = summary.defaultKeyStatistics;
    const price = summary.price;
    const detail = summary.summaryDetail;

    if (!stats) {
      console.log('Could not fetch statistics for CAR.');
      return;
    }

    const shortPercent = stats.shortPercentOfFloat?.raw || stats.shortPercentOfFloat || 0;
    const shortRatio = stats.shortRatio?.raw || stats.shortRatio || 0;
    const sharesShort = stats.sharesShort?.raw || stats.sharesShort || 0;
    const floatShares = stats.floatShares?.raw || stats.floatShares || 0;
    
    console.log('\n--- Short Interest Data ---');
    console.log(`Current Price: $${price.regularMarketPrice?.raw || price.regularMarketPrice}`);
    console.log(`Short % of Float: ${(shortPercent * 100).toFixed(2)}%`);
    console.log(`Short Ratio (Days to Cover): ${shortRatio.toFixed(2)}`);
    console.log(`Shares Short: ${sharesShort.toLocaleString()}`);
    console.log(`Float Shares: ${floatShares.toLocaleString()}`);

    // Analyze if a squeeze is happening or possible
    if (shortPercent > 0.20) {
      console.log('\nConclusion: YES, a Short Squeeze is HIGHLY probable or currently happening.');
      console.log('Characteristics: Short interest > 20% is very high.');
    } else if (shortPercent > 0.10) {
      console.log('\nConclusion: Moderate Short Squeeze potential.');
    } else {
      console.log('\nConclusion: Short Interest is relatively low, a pure "short squeeze" as the main driver is less likely, but still possible if liquidity is low.');
    }

    if (shortRatio > 5) {
      console.log(`Alert: High Days to Cover (${shortRatio.toFixed(2)}). It would take shorts over 5 days of average volume to exit their positions.`);
    }

  } catch (err) {
    console.error('Error analyzing CAR:', err);
  }
}

analyzeCARShortSqueeze();
