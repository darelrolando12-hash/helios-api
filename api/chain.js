module.exports = async function handler(req, res) {
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

  // ─── Helper: fetch spot price directly from Polygon snapshot ─────────────────
  // Used as fallback when underlying_asset is missing from options results
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

  // ─── MODE 1: Fetch available expiry dates ─────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${polygonKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`Polygon contracts API failed: ${response.status}`);
        return res.status(200).json({ expiryDates: [] });
      }

      const data = await response.json();

      if (!data.results || !Array.isArray(data.results)) {
        return res.status(200).json({ expiryDates: [] });
      }

      const dates = new Set();
      data.results.forEach(contract => {
        if (contract.expiration_date) dates.add(contract.expiration_date);
      });

      const sortedDates = Array.from(dates).sort();
      return res.status(200).json({ expiryDates: sortedDates, count: sortedDates.length });

    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── MODE 2: Full options chain ───────────────────────────────────────────────
  if (expiration) {
    try {
      const callsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${expiration}&limit=250&apiKey=${polygonKey}`;
      const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${expiration}&limit=250&apiKey=${polygonKey}`;

      const [callsRes, putsRes] = await Promise.all([fetch(callsUrl), fetch(putsUrl)]);

      if (!callsRes.ok || !putsRes.ok) {
        console.error(`Polygon options snapshot failed: calls=${callsRes.status}, puts=${putsRes.status}`);
        return res.status(200).json({ contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration });
      }

      const [callsData, putsData] = await Promise.all([callsRes.json(), putsRes.json()]);

      // ── Spot price extraction ────────────────────────────────────────────────
      // Polygon's underlying_asset is present on snapshot results but may be missing
      // if the options results array is empty. Always fall back to direct snapshot.
      let spot = 0;
      let spotPrevClose = 0;

      const ua = callsData.results?.[0]?.underlying_asset
               ?? putsData.results?.[0]?.underlying_asset
               ?? null;

      if (ua && ua.price > 0) {
        spot = ua.price;
        // Polygon day object: { o, h, l, c, v, vw, prev_close }
        spotPrevClose = ua.day?.prev_close ?? ua.day?.c ?? 0;
      }

      // Fallback: if underlying_asset didn't give us a price, hit the stock snapshot
      if (spot <= 0) {
        const fallback = await fetchSpot(sym);
        spot = fallback.price;
        spotPrevClose = fallback.prevClose;
      }

      const spotChangePct = (spot > 0 && spotPrevClose > 0)
        ? ((spot - spotPrevClose) / spotPrevClose) * 100
        : 0;

      // ── Build contract map by strike ─────────────────────────────────────────
      const contractMap = new Map();

      function ensureStrike(strike) {
        if (!contractMap.has(strike)) {
          contractMap.set(strike, {
            strike,
            callBid: 0, callAsk: 0, callIV: 0,  callOI: 0,  callVolume: 0,
            callDelta: null, callTheta: null,
            putBid: 0,  putAsk: 0,  putIV: 0,   putOI: 0,   putVolume: 0,
            putDelta: null, putTheta: null,
            atm: false, itmCall: false, itmPut: false,
          });
        }
        return contractMap.get(strike);
      }

      // Process calls
      if (Array.isArray(callsData.results)) {
        callsData.results.forEach(c => {
          const strike = c.details?.strike_price;
          if (!strike) return;
          const entry = ensureStrike(strike);

          entry.callBid    = c.market_data?.bid            ?? 0;
          entry.callAsk    = c.market_data?.ask            ?? 0;
          // IV: Polygon returns decimal (0.42 = 42%) — multiply ×100 for display
          entry.callIV     = c.greeks?.implied_volatility != null
            ? parseFloat((c.greeks.implied_volatility * 100).toFixed(1))
            : 0;
          entry.callOI     = c.open_interest               ?? 0;
          entry.callVolume = c.volume                      ?? 0;
          // Greeks — keep as-is (delta: -1 to 1, theta: negative decimal per day)
          entry.callDelta  = c.greeks?.delta  ?? null;
          entry.callTheta  = c.greeks?.theta  ?? null;
        });
      }

      // Process puts
      if (Array.isArray(putsData.results)) {
        putsData.results.forEach(p => {
          const strike = p.details?.strike_price;
          if (!strike) return;
          const entry = ensureStrike(strike);

          entry.putBid    = p.market_data?.bid             ?? 0;
          entry.putAsk    = p.market_data?.ask             ?? 0;
          entry.putIV     = p.greeks?.implied_volatility != null
            ? parseFloat((p.greeks.implied_volatility * 100).toFixed(1))
            : 0;
          entry.putOI     = p.open_interest                ?? 0;
          entry.putVolume = p.volume                       ?? 0;
          entry.putDelta  = p.greeks?.delta  ?? null;
          entry.putTheta  = p.greeks?.theta  ?? null;
        });
      }

      // ── ATM / ITM flags using real spot ─────────────────────────────────────
      // Strike step by price tier — used to determine ATM band
      const strikeStep = spot < 10 ? 0.5
                       : spot < 50 ? 1
                       : spot < 200 ? 5
                       : spot < 500 ? 10
                       : 25;

      const contracts = Array.from(contractMap.values())
        .sort((a, b) => a.strike - b.strike)
        .map(c => ({
          ...c,
          // ATM = within 60% of one strike step from spot (or ±$1 minimum)
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

  // ─── No mode specified ────────────────────────────────────────────────────────
  return res.status(400).json({
    error: 'Either datesOnly=true or expiration parameter required',
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true  OR  GET /api/chain?symbol=TSLA&expiration=2026-06-20',
  });
};
