const axios = require('axios');
const token = process.env.ACCESS_TOKEN;
const symbol = process.env.SYMBOL || 'BTC-USD';
const baseURL = 'https://perps.standx.com';
if (!token) {
  console.error('ACCESS_TOKEN not provided. Set ACCESS_TOKEN in env to use this script.');
  process.exit(1);
}

async function sample() {
  try {
    const priceRes = await axios.get(`${baseURL}/api/query_symbol_price?symbol=${symbol}`, { headers:{ Authorization: `Bearer ${token}` } });
    const obRes = await axios.get(`${baseURL}/api/query_depth_book?symbol=${symbol}`, { headers:{ Authorization: `Bearer ${token}` } });
    const price = priceRes.data || {};
    const ob = obRes.data || {};
    const mark = parseFloat(price.mark_price || price.index_price || 0);
    const bids = ob.bids || [], asks = ob.asks || [];
    const hasBid = bids.length && Math.abs((bids[0][0]-mark)/mark) <= 0.001;
    const hasAsk = asks.length && Math.abs((asks[0][0]-mark)/mark) <= 0.001;
    console.log(new Date().toISOString(), { mark, bid: bids[0]?.[0], ask: asks[0]?.[0], within10bps: !!(hasBid && hasAsk) });
  } catch (e) {
    console.error('Error sampling:', e.message || e);
  }
}

setInterval(sample, 15000);
sample();
