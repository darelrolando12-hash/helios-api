module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;
  if (!polygonKey) return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });

  try {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 5);
    const fromStr = from.toISOString().split('T')[0];
    const toStr   = now.toISOString().split('T')[0];

    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/5/minute/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=50&apiKey=${polygonKey}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Helios/1.0' } });

    if (!response.ok) return res.status(200).json({ symbol: sym, points: [] });

    const data = await response.json();
    const points = (data?.results ?? []).slice(-20).map((bar) => ({
      t: bar.t,
      c: bar.c,
      v: bar.v,
    }));

    return res.status(200).json({ symbol: sym, points });

  } catch (err) {
    return res.status(200).json({ symbol: sym, points: [] });
  }
};
