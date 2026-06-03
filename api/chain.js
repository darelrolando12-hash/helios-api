export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  // Convert "Jun 20" → "2025-06-20" format Polygon expects
  const months = {
    Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
    Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12"
  };
  let expDate = "";
  if (expiration) {
    const [mon, day] = expiration.split(" ");
    const year = new Date().getFullYear();
    expDate = `${year}-${months[mon] || "06"}-${String(day).padStart(2, "0")}`;
  }

  const params = new URLSearchParams({
    apiKey: process.env.POLYGON_API_KEY,
    limit: "250",
    ...(expDate && { expiration_date: expDate }),
  });

  const url = `https://api.polygon.io/v3/snapshot/options/${symbol.toUpperCase()}?${params}`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
