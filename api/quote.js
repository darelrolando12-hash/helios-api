export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=2d`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(404).json({ error: `No data for ${symbol}` });

    res.json({
      ticker: {
        day: { c: meta.regularMarketPrice, v: meta.regularMarketVolume },
        prevDay: { c: meta.chartPreviousClose || meta.previousClose },
        name: meta.shortName || symbol.toUpperCase(),
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
