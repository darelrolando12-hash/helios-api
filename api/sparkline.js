export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const sym = symbol.toUpperCase().trim();

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance returned ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result) {
      throw new Error(`No data found for ${sym}`);
    }

    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const prices = closes
      .filter((p) => p !== null && p !== undefined && !isNaN(p))
      .map((p) => parseFloat(p.toFixed(2)));

    return res.status(200).json({ symbol: sym, prices });
  } catch (err) {
    console.error(`Sparkline error for ${sym}:`, err);
    return res.status(500).json({ error: err.message || 'Failed to fetch sparkline' });
  }
}
