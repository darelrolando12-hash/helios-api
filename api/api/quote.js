export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { symbol } = req.query;
  const r = await fetch(
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${process.env.POLYGON_API_KEY}`
  );
  const data = await r.json();
  res.json(data);
}
