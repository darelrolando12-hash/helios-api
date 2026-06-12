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
      contracts: []
    });
  }

  // ─── MODE 1: Fetch available expiry dates ───────────────────────────────────
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
        if (contract.expiration_date) {
          dates.add(contract.expiration_date);
        }
      });

      const sortedDates = Array.from(dates).sort();

      return res.status(200).json({
        expiryDates: sortedDates,
        count: sortedDates.length
      });

    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── MODE 2: Fetch full options chain for a specific expiry ─────────────────
  if (expiration) {
    try {
      const callsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${expiration}&limit=250&apiKey=${polygonKey}`;
      const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${expiration}&limit=250&apiKey=${polygonKey}`;

      const [callsRes, putsRes] = await Promise.all([
        fetch(callsUrl),
        fetch(putsUrl)
      ]);

      if (!callsRes.ok || !putsRes.ok) {
        console.error(`Polygon snapshot failed: calls=${callsRes.status}, puts=${putsRes.status}`);
        return res.status(200).json({ contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration });
      }

      const [callsData, putsData] = await Promise.all([
        callsRes.json(),
        putsRes.json()
      ]);

      // Underlying spot price + prev close → used by frontend for volatility-aware cache TTL
      let spot = 0;
      let spotPrevClose = 0;
      if (callsData.results?.[0]?.underlying_asset?.price) {
        spot = callsData.results[0].underlying_asset.price;
        spotPrevClose = callsData.results[0].underlying_asset?.prev_close_price || 0;
      } else if (putsData.results?.[0]?.underlying_asset?.price) {
        spot = putsData.results[0].underlying_asset.price;
        spotPrevClose = putsData.results[0].underlying_asset?.prev_close_price || 0;
      }
      const spotChangePct = spotPrevClose > 0
        ? ((spot - spotPrevClose) / spotPrevClose) * 100
        : 0;

      // Build contract map keyed by strike
      const contractMap = new Map();

      if (Array.isArray(callsData.results)) {
        callsData.results.forEach(c => {
          const strike = c.details?.strike_price;
          if (!strike) return;
          if (!contractMap.has(strike)) {
            contractMap.set(strike, {
              strike,
              callBid: 0, callAsk: 0, callIV: 0, callOI: 0, callVolume: 0,
              putBid:  0, putAsk:  0, putIV:  0, putOI:  0, putVolume:  0,
              atm: false, itmCall: false, itmPut: false
            });
          }
          const entry = contractMap.get(strike);
          entry.callBid    = c.market_data?.bid              || 0;
          entry.callAsk    = c.market_data?.ask              || 0;
          entry.callIV     = c.greeks?.implied_volatility    || 0;
          entry.callOI     = c.open_interest                 || 0;
          entry.callVolume = c.volume                        || 0;
        });
      }

      if (Array.isArray(putsData.results)) {
        putsData.results.forEach(p => {
          const strike = p.details?.strike_price;
          if (!strike) return;
          if (!contractMap.has(strike)) {
            contractMap.set(strike, {
              strike,
              callBid: 0, callAsk: 0, callIV: 0, callOI: 0, callVolume: 0,
              putBid:  0, putAsk:  0, putIV:  0, putOI:  0, putVolume:  0,
              atm: false, itmCall: false, itmPut: false
            });
          }
          const entry = contractMap.get(strike);
          entry.putBid    = p.market_data?.bid              || 0;
          entry.putAsk    = p.market_data?.ask              || 0;
          entry.putIV     = p.greeks?.implied_volatility    || 0;
          entry.putOI     = p.open_interest                 || 0;
          entry.putVolume = p.volume                        || 0;
        });
      }

      // Sort by strike, mark ATM / ITM
      const contracts = Array.from(contractMap.values())
        .sort((a, b) => a.strike - b.strike)
        .map(c => {
          const strikeStep = spot < 10 ? 0.5 : spot < 50 ? 1 : spot < 200 ? 5 : 10;
          return {
            ...c,
            atm:     Math.abs(c.strike - spot) < strikeStep * 0.6,
            itmCall: c.strike < spot,
            itmPut:  c.strike > spot
          };
        });

      return res.status(200).json({
        symbol: sym,
        spot,
        spotChangePct,
        expiration,
        contracts
      });

    } catch (error) {
      console.error('Error fetching options chain:', error);
      return res.status(200).json({ contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration });
    }
  }

  // ─── No valid mode ───────────────────────────────────────────────────────────
  return res.status(400).json({
    error: 'Either datesOnly=true or expiration parameter required',
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true  OR  GET /api/chain?symbol=TSLA&expiration=2026-06-20'
  });
};
