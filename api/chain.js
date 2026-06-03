export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  const months = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"
  };

  let expDate = "";
  if (expiration) {
    const [mon, day] = expiration.split(" ");
    const year = new Date().getFullYear();
    expDate = `${year}-${months[mon] || "06"}-${String(day).padStart(2,"0")}`;
  }

  const key = process.env.POLYGON_API_KEY;

  // Use the options contracts endpoint (Starter plan+)
  const params = new URLSearchParams({
    apiKey: key,
    limit: "250",
    contract_type: "call",
    ...(expDate && { expiration_date: expDate }),
  });
  const params2 = new URLSearchParams({
    apiKey: key,
    limit: "250",
    contract_type: "put",
    ...(expDate && { expiration_date: expDate }),
  });

  try {
    const sym = symbol.toUpperCase();
    const [callRes, putRes] = await Promise.all([
      fetch(`https://api.polygon.io/v3/snapshot/options/${sym}?${params}`),
      fetch(`https://api.polygon.io/v3/snapshot/options/${sym}?${params2}`),
    ]);
    const [callData, putData] = await Promise.all([callRes.json(), putRes.json()]);

    const results = [
      ...(callData.results || []),
      ...(putData.results || []),
    ];
    res.json({ results, status: "OK" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
