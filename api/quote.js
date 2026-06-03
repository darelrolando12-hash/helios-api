export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  const sym = symbol.toUpperCase();
  const key = process.env.POLYGON_API_KEY;

  try {
    // Fetch previous close (free tier)
    const prevRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${key}`
    );
    const prevData = await prevRes.json();
    const prev = prevData?.results?.[0];
    if (!prev) return res.status(404).json({ error: `No data for ${sym}` });

    // Fetch latest trade for real-time price (free tier)
    const tradeRes = await fetch(
      `https://api.polygon.io/v2/last/trade/${sym}?apiKey=${key}`
    );
    const tradeData = await tradeRes.json();
    const lastPrice = tradeData?.results?.p || prev.c;

    const change = lastPrice - prev.c;
    const changePct = prev.c !== 0 ? (change / prev.c) * 100 : 0;

    res.json({
      ticker: {
        day: { c: lastPrice, v: prev.v },
        prevDay: { c: prev.c },
        name: sym,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
