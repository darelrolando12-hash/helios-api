const POLYGON_KEY = process.env.POLYGON_API_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol, limit = '300' } = req.query;

  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });

  const sym = symbol.toString().toUpperCase().trim();
  const lim = Math.min(500, Math.max(50, parseInt(limit.toString(), 10) || 300));

  try {
    // Polygon v3/trades — returns the most recent trades for a ticker
    const url = `https://api.polygon.io/v3/trades/${encodeURIComponent(sym)}?limit=${lim}&sort=timestamp&order=desc&apiKey=${POLYGON_KEY}`;
    const polyRes = await fetch(url);

    if (!polyRes.ok) {
      const errText = await polyRes.text().catch(() => '');
      return res.status(polyRes.status).json({ error: `Polygon error: ${polyRes.status}`, detail: errText });
    }

    const data = await polyRes.json();

    // Pass through the results array — front-end needs: price, size per trade
    // Add cache control: 30s (trades are real-time, but we don't need sub-second)
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    return res.status(200).json({
      results: data.results ?? [],
      count: (data.results ?? []).length,
      symbol: sym,
    });

  } catch (err) {
    console.error('[trades] fetch error:', err?.message ?? err);
    return res.status(500).json({ error: 'Failed to fetch trades', detail: err?.message });
  }
}
