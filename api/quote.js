module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();

  const polygonKey = process.env.POLYGON_API_KEY;
  if (polygonKey) {
    try {
      const polyRes = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (polyRes.ok) {
        const data = await polyRes.json();
        const t = data?.ticker;
        if (t) {
          const price = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
          const prevClose = t.prevDay?.c || price;
          const change = price - prevClose;
          const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
          return res.status(200).json({
            symbol: sym,
            price,
            change,
            changePct,
            high: t.day?.h ?? null,
            low: t.day?.l ?? null,
            open: t.day?.o ?? null,
            prevClose,
            volume: t.day?.v ?? 0,
            name: t.name ?? sym,
            week52High: t.day?.h ?? null,
            week52Low: t.day?.l ?? null,
            source: 'polygon',
          });
        }
      }
    } catch (e) {
      console.warn('Polygon quote failed, falling back to Yahoo:', e.message);
    }
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
    const yahooRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Helios/1.0)',
        Accept: 'application/json',
      },
    });
    if (!yahooRes.ok) throw new Error(`Yahoo status ${yahooRes.status}`);
    const json = await yahooRes.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta in Yahoo response');

    const price = meta.regularMarketPrice ?? meta.previousClose ?? 0;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol: sym,
      price,
      change,
      changePct,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      open: meta.regularMarketOpen ?? null,
      prevClose,
      volume: meta.regularMarketVolume ?? 0,
      name: meta.shortName ?? meta.longName ?? sym,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low: meta.fiftyTwoWeekLow ?? null,
      source: 'yahoo',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Quote fetch failed' });
  }
};
