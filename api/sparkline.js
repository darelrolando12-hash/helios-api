export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&period1=${Math.floor(new Date(from).getTime()/1000)}&period2=${Math.floor(new Date(to).getTime()/1000)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const data = await r.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const results = closes.filter(Boolean).map((c) => ({ c }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
