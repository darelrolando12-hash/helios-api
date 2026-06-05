export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not set' });

  const base = `https://api.polygon.io/v3/snapshot/options/${symbol.toUpperCase()}`;
  const params = expiration
    ? `?expiration_date=${expiration}&limit=250&apiKey=${key}`
    : `?limit=250&apiKey=${key}`;

  try {
    const [callsRes, putsRes] = await Promise.all([
      fetch(`${base}${params}&contract_type=call`),
      fetch(`${base}${params}&contract_type=put`),
    ]);

    const [callsData, putsData] = await Promise.all([
      callsRes.json(),
      putsRes.json(),
    ]);

    // Normalize Polygon v3 snapshot shape
    const normalize = (item) => ({
      strike_price: item.details?.strike_price,
      expiration_date: item.details?.expiration_date,
      contract_type: item.details?.contract_type,
      open_interest: item.open_interest,
      volume: item.day?.volume,
      implied_volatility: item.implied_volatility,
      delta: item.greeks?.delta,
      gamma: item.greeks?.gamma,
      theta: item.greeks?.theta,
      vega: item.greeks?.vega,
      last_price: item.day?.last_price ?? item.last_quote?.ask,
      bid: item.last_quote?.bid,
      ask: item.last_quote?.ask,
    });

    res.json({
      calls: (callsData.results || []).map(normalize),
      puts: (putsData.results || []).map(normalize),
    });
  } catch (err) {
    res.status(500).json({ error: err.message ?? 'Fetch failed' });
  }
}
