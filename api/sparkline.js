export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not set' });

  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol.toUpperCase()}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=10&apiKey=${key}`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    const prices = (data.results || []).map(b => b.c);
    res.json({ symbol: symbol.toUpperCase(), prices });
  } catch (err) {
    res.status(500).json({ error: err.message ?? 'Fetch failed' });
  }
}
