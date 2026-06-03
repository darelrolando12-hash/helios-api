export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const sym = symbol.toUpperCase().trim();
  const apiKey = process.env.POLYGON_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Missing POLYGON_API_KEY' });

  try {
    // Fetch spot price first
    const quoteRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${apiKey}`
    );
    const quoteData = await quoteRes.json();
    const spot = quoteData?.results?.[0]?.c ?? 0;

    // Build expiration date string (YYYY-MM-DD) from "Jun 20" style label
    let expDate = '';
    if (expiration) {
      const months = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const [mon, day] = expiration.split(' ');
      const year = new Date().getFullYear();
      expDate = `${year}-${months[mon] ?? '06'}-${day.padStart(2, '0')}`;
    }

    // Fetch calls and puts separately from Polygon v3 options snapshot
    const baseUrl = `https://api.polygon.io/v3/snapshot/options/${sym}`;
    const params = new URLSearchParams({
      limit: '250',
      apiKey,
      ...(expDate && { expiration_date: expDate }),
    });

    const [callsRes, putsRes] = await Promise.all([
      fetch(`${baseUrl}?${params}&contract_type=call`),
      fetch(`${baseUrl}?${params}&contract_type=put`),
    ]);

    const [callsData, putsData] = await Promise.all([
      callsRes.json(),
      putsRes.json(),
    ]);

    const callResults = callsData?.results ?? [];
    const putResults = putsData?.results ?? [];

    if (!callResults.length && !putResults.length) {
      return res.status(200).json({ symbol: sym, spot, expiration, contracts: [] });
    }

    // Index puts by strike for merging
    const putsByStrike = {};
    for (const p of putResults) {
      const strike = p.details?.strike_price ?? 0;
      putsByStrike[strike] = p;
    }

    // Build merged rows keyed by strike
    const strikeMap = {};

    for (const c of callResults) {
      const strike = c.details?.strike_price ?? 0;
      if (!strike) continue;
      strikeMap[strike] = strikeMap[strike] ?? { strike };
      strikeMap[strike].call = c;
    }

    for (const p of putResults) {
      const strike = p.details?.strike_price ?? 0;
      if (!strike) continue;
      strikeMap[strike] = strikeMap[strike] ?? { strike };
      strikeMap[strike].put = p;
    }

    const contracts = Object.values(strikeMap)
      .sort((a, b) => a.strike - b.strike)
      .map(({ strike, call, put }) => {
        const callBid   = call?.day?.last_price ?? call?.last_quote?.bid ?? 0;
        const callAsk   = call?.last_quote?.ask ?? callBid * 1.05;
        const callIV    = call?.implied_volatility ? parseFloat((call.implied_volatility * 100).toFixed(1)) : 0;
        const callOI    = call?.open_interest ?? 0;
        const callVol   = call?.day?.volume ?? 0;

        const putBid    = put?.day?.last_price ?? put?.last_quote?.bid ?? 0;
        const putAsk    = put?.last_quote?.ask ?? putBid * 1.05;
        const putIV     = put?.implied_volatility ? parseFloat((put.implied_volatility * 100).toFixed(1)) : 0;
        const putOI     = put?.open_interest ?? 0;
        const putVol    = put?.day?.volume ?? 0;

        const atm       = spot > 0 && Math.abs(strike - spot) / spot < 0.005;
        const itmCall   = spot > 0 && strike < spot;
        const itmPut    = spot > 0 && strike > spot;

        return {
          strike,
          callBid:    parseFloat(callBid.toFixed(2)),
          callAsk:    parseFloat(callAsk.toFixed(2)),
          callIV,
          callOI,
          callVolume: callVol,
          putBid:     parseFloat(putBid.toFixed(2)),
          putAsk:     parseFloat(putAsk.toFixed(2)),
          putIV,
          putOI,
          putVolume:  putVol,
          atm,
          itmCall,
          itmPut,
        };
      });

    return res.status(200).json({ symbol: sym, spot, expiration, contracts });
  } catch (err) {
    console.error(`Chain error for ${sym}:`, err);
    return res.status(500).json({ error: err.message || 'Failed to fetch options chain' });
  }
}
