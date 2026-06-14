module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, datesOnly, expiration } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter required' });
  }

  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  if (!polygonKey) {
    return res.status(500).json({
      error: 'POLYGON_API_KEY not configured',
      expiryDates: [],
      contracts: [],
    });
  }

  async function fetchSpot(ticker) {
    try {
      const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${polygonKey}`;
      const r = await fetch(url);
      if (!r.ok) return { price: 0, prevClose: 0 };
      const data = await r.json();
      const t = data?.ticker;
      if (!t) return { price: 0, prevClose: 0 };
      const price = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
      const prevClose = t.prevDay?.c || 0;
      return { price, prevClose };
    } catch {
      return { price: 0, prevClose: 0 };
    }
  }

  // ── MODE 1: dates only ──────────────────────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(sym)}&limit=250&sort=expiration_date&order=asc&apiKey=${polygonKey}`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Helios/1.0' } });

      if (!response.ok) {
        return res.status(200).json({ expiryDates: [] });
      }

      const data = await response.json();
      const results = data?.results ?? [];

      const today = new Date().toISOString().split('T')[0];
      const dates = [...new Set(
        results
          .map(r => r.expiration_date)
          .filter(d => d && d >= today)
      )].slice(0, 12);

      return res.status(200).json({ expiryDates: dates });

    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ── MODE 2: full chain for a specific expiration ────────────────────────────
  if (expiration) {
    try {
      const callsUrl = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date=${expiration}&contract_type=call&limit=250&apiKey=${polygonKey}`;
      const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date=${expiration}&contract_type=put&limit=250&apiKey=${polygonKey}`;

      const [callsRes, putsRes, spotData] = await Promise.all([
        fetch(callsUrl, { headers: { 'User-Agent': 'Helios/1.0' } }),
        fetch(putsUrl,  { headers: { 'User-Agent': 'Helios/1.0' } }),
        fetchSpot(sym),
      ]);

      let spot = spotData.price;
      const prevClose = spotData.prevClose;
      const spotChangePct = (spot > 0 && prevClose > 0)
        ? ((spot - prevClose) / prevClose) * 100
        : 0;

      const callsData = callsRes.ok ? await callsRes.json() : { results: [] };
      const putsData  = putsRes.ok  ? await putsRes.json()  : { results: [] };

      const callResults = callsData?.results ?? [];
      const putResults  = putsData?.results  ?? [];

      // Pull spot from first result if not found above
      if (spot === 0 && callResults.length > 0) {
        spot = callResults[0]?.underlying_asset?.price ?? 0;
      }

      // Build contract map keyed by strike
      const contractMap = new Map();

      const getEntry = (strike) => {
        if (!contractMap.has(strike)) {
          contractMap.set(strike, {
            strike,
            callBid: null, callAsk: null, callIV: null, callOI: null,
            callVolume: null, callDelta: null, callTheta: null,
            putBid: null,  putAsk: null,  putIV: null,  putOI: null,
            putVolume: null, putDelta: null, putTheta: null,
          });
        }
        return contractMap.get(strike);
      };

      for (const c of callResults) {
        const strike = c.details?.strike_price ?? c.strike_price;
        if (!strike) continue;
        const entry = getEntry(strike);
        const day = c.day ?? {};
        const greeks = c.greeks ?? {};
        const iv = c.implied_volatility;
        entry.callBid    = day.last_price ?? c.last_quote?.bid ?? null;
        entry.callAsk    = c.last_quote?.ask ?? day.last_price ?? null;
        entry.callIV     = iv != null ? iv * 100 : null;
        entry.callOI     = c.open_interest ?? day.open_interest ?? null;
        entry.callVolume = day.volume ?? null;
        entry.callDelta  = greeks.delta ?? null;
        entry.callTheta  = greeks.theta ?? null;
      }

      for (const p of putResults) {
        const strike = p.details?.strike_price ?? p.strike_price;
        if (!strike) continue;
        const entry = getEntry(strike);
        const day = p.day ?? {};
        const greeks = p.greeks ?? {};
        const iv = p.implied_volatility;
        entry.putBid    = day.last_price ?? p.last_quote?.bid ?? null;
        entry.putAsk    = p.last_quote?.ask ?? day.last_price ?? null;
        entry.putIV     = iv != null ? iv * 100 : null;
        entry.putOI     = p.open_interest ?? day.open_interest ?? null;
        entry.putVolume = day.volume ?? null;
        entry.putDelta  = greeks.delta ?? null;
        entry.putTheta  = greeks.theta ?? null;
      }

      const strikeStep = spot < 10 ? 0.5
                       : spot < 50 ? 1
                       : spot < 200 ? 5
                       : spot < 500 ? 10
                       : 25;

      const contracts = Array.from(contractMap.values())
        .sort((a, b) => a.strike - b.strike)
        .map(c => ({
          ...c,
          atm:     spot > 0 && Math.abs(c.strike - spot) < Math.max(strikeStep * 0.6, 1),
          itmCall: spot > 0 ? c.strike < spot : false,
          itmPut:  spot > 0 ? c.strike > spot : false,
        }));

      return res.status(200).json({
        symbol: sym,
        spot,
        spotChangePct,
        expiration,
        contracts,
      });

    } catch (error) {
      console.error('Error fetching options chain:', error);
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
      });
    }
  }

  return res.status(400).json({
    error: 'Either datesOnly=true or expiration parameter required',
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true  OR  GET /api/chain?symbol=TSLA&expiration=2026-06-20',
  });
};
