import axios from 'axios';

async function test() {
  try {
    const url = 'https://api.nasdaq.com/api/calendar/earnings?date=2026-03-12';
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    console.log(`Found ${data.data.rows?.length || 0} earnings`);
    if (data.data.rows) {
      console.log(data.data.rows.slice(0, 3));
    }
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
}
test();
