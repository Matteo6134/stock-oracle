import axios from 'axios';
import fs from 'fs';

async function test() {
  const dateStr = new Date().toISOString().split('T')[0];
  const url = `https://finance.yahoo.com/calendar/earnings?day=${dateStr}`;
  console.log(`Fetching ${url}...`);
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  fs.writeFileSync('yahoo-html.txt', html);
  console.log('Saved to yahoo-html.txt');
  
  // Try to find symbols another way
  const matches1 = html.match(/data-symbol="[^"]+"/g);
  console.log('data-symbol matches:', matches1 ? matches1.length : 0);
  
  const matches2 = html.match(/"symbol":"([A-Z]+)"/g);
  console.log('"symbol":"..." matches:', matches2 ? matches2.length : 0);
}
test();
