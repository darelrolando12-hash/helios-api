const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;
const MAX_PAGES = 10;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function polygonFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt * 2); // longer backoff on rate limit
        return polygonFetch(url, attempt + 1);
      }
      console.error('[chain.js] Polygon 429 after all retries');
      return null;
    }

    if (!res.ok) {
      if (attempt < MAX_RETRIES && (res.status >= 500 || res.status === 403)) {
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      console.error(`[chain.js] Polygon ${res.status} after ${attempt} attempts`);
      return null;
    }

    return await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    console.error('[chain.js] Polygon fetch failed after all retries:', err.message);
    return null;
  }
}

// Phase 3: Block trade detection (conditions code 41 or large size trades)
function isBlockTrade(contract) {
  if (!contract) return false;
  const conditions = contract.market_data?.conditions ?? [];
  if (conditions.includes(41)) return true;
  const size = contract.market_data?.last_trade?.size ?? 0;
  return size >= 100;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not set' });
  }

  const sym = (req.query.symbol ?? '').trim().toUpperCase();
  if (!sym) {
    return res.status(400).json({ error: 'symbol query param required' });
  }

  // ─── Mode 1: ?datesOnly=true ──────────────────────────────────────────────────
  if (req.query.datesOnly === 'true') {
    try {
      const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
      const data = await polygonFetch(url);
      if (!data || !data.results) {
        return res.status(200).json({ expiryDates: [] });
      }
      const unique = [...new Set(data.results.map(c => c.expiration_date))];
      const sorted = unique.sort((a, b) => new Date(a) - new Date(b));
      return res.status(200).json({ expiryDates: sorted });
    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── Mode 3: ?allExpiries=true — Multi-expiry GEX stack data ─────────────────
  if (req.query.allExpiries === 'true') {
    try {
      // Fetch all available expiries first
      const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
      const datesData = await polygonFetch(datesUrl);
      if (!datesData || !datesData.results) {
        return res.status(200).json({ expiries: [] });
      }

      const uniqueDates = [...new Set(datesData.results.map(c => c.expiration_date))];
      const sortedDates = uniqueDates.sort((a, b) => new Date(a) - new Date(b));

      // Fetch spot price once
      const spotUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?apiKey=${apiKey}`;
      const spotData = await polygonFetch(spotUrl);
      const spot = spotData?.results?.[0]?.c ?? 0;

      // Fetch chains for each expiry (limit to first 6 for performance)
      const expiriesToFetch = sortedDates.slice(0, 6);
      const results = await Promise.allSettled(
        expiriesToFetch.map(async expiry => {
          const callsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${expiry}&limit=250&apiKey=${apiKey}`;
          const putsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${expiry}&limit=250&apiKey=${apiKey}`;

          const [callsData, putsData] = await Promise.all([
            polygonFetch(callsUrl),
            polygonFetch(putsUrl),
          ]);

          const callsResults = callsData?.results ?? [];
          const putsResults = putsData?.results ?? [];

          // Compute GEX for this expiry
          let totalCallGamma = 0;
          let totalPutGamma = 0;
          let atmStrike = 0;
          let minDiff = Infinity;

          const strikes = new Set();
          callsResults.forEach(c => {
            const strike = c.details?.strike_price;
            if (!strike) return;
            strikes.add(strike);
            const gamma = c.greeks?.gamma ?? 0;
            const oi = c.open_interest ?? 0;
            totalCallGamma += gamma * oi * 100; // 100 shares per contract
            const diff = Math.abs(strike - spot);
            if (diff < minDiff) {
              minDiff = diff;
              atmStrike = strike;
            }
          });

          putsResults.forEach(p => {
            const strike = p.details?.strike_price;
            if (!strike) return;
            strikes.add(strike);
            const gamma = p.greeks?.gamma ?? 0;
            const oi = p.open_interest ?? 0;
            totalPutGamma += gamma * oi * 100;
          });

          const netGamma = totalCallGamma - totalPutGamma;

          return {
            expiry,
            dte: Math.ceil((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24)),
            netGamma,
            totalCallGamma,
            totalPutGamma,
            atmStrike,
            contractCount: callsResults.length + putsResults.length,
          };
        })
      );

      const expiries = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      return res.status(200).json({ expiries, spot });
    } catch (error) {
      console.error('Error fetching multi-expiry GEX:', error);
      return res.status(200).json({ expiries: [], spot: 0 });
    }
  }

  // ─── Mode 2: Full chain for single expiration ─────────────────────────────────
  const expiration = req.query.expiration;
  if (expiration) {
    try {
      // Fetch spot + VWAP
      const spotUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?apiKey=${apiKey}`;
      const spotData = await polygonFetch(spotUrl);
      const prevClose = spotData?.results?.[0]?.c ?? 0;
      const spotVwap = spotData?.results?.[0]?.vw ?? prevClose;
      const spot = prevClose;
      const spotChangePct = prevClose > 0 && spotData?.results?.[0]?.o
        ? parseFloat((((prevClose - spotData.results[0].o) / spotData.results[0].o) * 100).toFixed(2))
        : 0;

      if (spot === 0) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
          source: 'polygon-no-spot',
        });
      }

      // Validate + slide expiration date to nearest available
      const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
      const datesData = await polygonFetch(datesUrl);
      if (!datesData || !datesData.results) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot, spotChangePct, expiration,
          source: 'polygon-no-dates',
        });
      }

      const uniqueDates = [...new Set(datesData.results.map(c => c.expiration_date))];
      const sortedDates = uniqueDates.sort((a, b) => new Date(a) - new Date(b));

      let resolvedExpiration = expiration;
      if (!sortedDates.includes(expiration)) {
        const target = new Date(expiration);
        let closest = sortedDates[0];
        let minDiff = Math.abs(new Date(sortedDates[0]) - target);
        for (const d of sortedDates) {
          const diff = Math.abs(new Date(d) - target);
          if (diff < minDiff) {
            minDiff = diff;
            closest = d;
          }
        }
        resolvedExpiration = closest;
        console.log(`[chain.js] Slid ${expiration} → ${resolvedExpiration}`);
      }

      // Fetch calls + puts with pagination
      const callsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${resolvedExpiration}&limit=250&apiKey=${apiKey}`;
      const putsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${resolvedExpiration}&limit=250&apiKey=${apiKey}`;

      let callsResults = [];
      let putsResults = [];
      let callsNextUrl = callsUrl;
      let putsNextUrl = putsUrl;
      let callsPages = 0;
      let putsPages = 0;

      while (callsNextUrl && callsPages < MAX_PAGES) {
        const data = await polygonFetch(callsNextUrl);
        if (!data || !data.results) break;
        callsResults = callsResults.concat(data.results);
        callsNextUrl = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
        callsPages++;
      }

      while (putsNextUrl && putsPages < MAX_PAGES) {
        const data = await polygonFetch(putsNextUrl);
        if (!data || !data.results) break;
        putsResults = putsResults.concat(data.results);
        putsNextUrl = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
        putsPages++;
      }

      if (callsResults.length === 0 && putsResults.length === 0) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot, spotChangePct, expiration: resolvedExpiration,
          source: 'polygon-no-contracts',
        });
      }

      // Implied move (ATM straddle)
      let impliedMove = null;
      let minDiff = Infinity;
      let atmCall = null;
      let atmPut = null;

      callsResults.forEach(c => {
        const strike = c.details?.strike_price;
        if (!strike) return;
        const diff = Math.abs(strike - spot);
        if (diff < minDiff) {
          minDiff = diff;
          atmCall = c;
        }
      });

      putsResults.forEach(p => {
        const strike = p.details?.strike_price;
        if (!strike || !atmCall) return;
        if (Math.abs(strike - atmCall.details.strike_price) < 0.5) {
          atmPut = p;
        }
      });

      if (atmCall && atmPut) {
        const callMid = ((atmCall.market_data?.bid ?? 0) + (atmCall.market_data?.ask ?? 0)) / 2;
        const putMid = ((atmPut.market_data?.bid ?? 0) + (atmPut.market_data?.ask ?? 0)) / 2;
        const straddleCost = callMid + putMid;
        impliedMove = straddleCost > 0 ? parseFloat((straddleCost / spot * 100).toFixed(2)) : null;
      }

      // Merge calls + puts
      const strikeMap = new Map();
      function ensureStrike(strike) {
        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, {
            strike,
            callBid: 0, callAsk: 0, callLast: null, callIV: 0, callVolume: 0, callOI: 0,
            putBid: 0, putAsk: 0, putLast: null, putIV: 0, putVolume: 0, putOI: 0,
            callDelta: null, callGamma: null, callTheta: null, callVega: null,
            putDelta: null, putGamma: null, putTheta: null, putVega: null,
            callVanna: null, callCharm: null, putVanna: null, putCharm: null,
            callDayVol: 0, callPrevDayVol: 0, callVolumeRatio: null,
            putDayVol: 0, putPrevDayVol: 0, putVolumeRatio: null,
            callBlockTrade: false, putBlockTrade: false,
            callIlliquid: false, putIlliquid: false,
          });
        }
        return strikeMap.get(strike);
      }

      // Process calls
      callsResults.forEach(c => {
        const strike = c.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);

        const bid  = c.market_data?.bid ?? 0;
        const ask  = c.market_data?.ask ?? 0;
        const lastTradePrice = c.market_data?.last_trade?.price
          ?? c.market_data?.last_quote?.midpoint
          ?? null;

        entry.callBid    = bid;
        entry.callAsk    = ask;
        entry.callLast   = lastTradePrice;
        entry.callIV     = c.greeks?.implied_volatility != null
          ? parseFloat((c.greeks.implied_volatility * 100).toFixed(1))
          : 0;
        entry.callOI     = c.open_interest ?? 0;
        // Polygon puts daily volume in c.day.volume; c.volume is often 0 or missing
        entry.callVolume = c.day?.volume ?? c.volume ?? 0;
        // Phase 2 Greeks — REAL Polygon data only, no fallback
        entry.callDelta  = c.greeks?.delta  ?? null;
        entry.callTheta  = c.greeks?.theta  ?? null;
        entry.callGamma  = c.greeks?.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
        entry.callVega   = c.greeks?.vega   ?? null;
        // Phase 3 Greeks: vanna & charm
        entry.callVanna  = c.greeks?.vanna  ?? null;
        entry.callCharm  = c.greeks?.charm  ?? null;
        // Volume ratio
        entry.callDayVol     = c.day?.volume      ?? 0;
        entry.callPrevDayVol = c.prev_day?.volume ?? 0;
        entry.callVolumeRatio = entry.callPrevDayVol > 0
          ? parseFloat((entry.callDayVol / entry.callPrevDayVol).toFixed(2))
          : null;
        // Phase 3: block trade detection
        entry.callBlockTrade = isBlockTrade(c);
        // Illiquid flag: spread > 50% of ask
        entry.callIlliquid = ask > 0 && (ask - bid) / ask > 0.5;
      });

      // Process puts
      putsResults.forEach(p => {
        const strike = p.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);

        const bid  = p.market_data?.bid ?? 0;
        const ask  = p.market_data?.ask ?? 0;
        const lastTradePrice = p.market_data?.last_trade?.price
          ?? p.market_data?.last_quote?.midpoint
          ?? null;

        entry.putBid    = bid;
        entry.putAsk    = ask;
        entry.putLast   = lastTradePrice;
        entry.putIV     = p.greeks?.implied_volatility != null
          ? parseFloat((p.greeks.implied_volatility * 100).toFixed(1))
          : 0;
        entry.putOI     = p.open_interest ?? 0;
        entry.putVolume = p.day?.volume ?? p.volume ?? 0;
        entry.putDelta  = p.greeks?.delta  ?? null;
        entry.putTheta  = p.greeks?.theta  ?? null;
        entry.putGamma  = p.greeks?.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
        entry.putVega   = p.greeks?.vega   ?? null;
        entry.putVanna  = p.greeks?.vanna  ?? null;
        entry.putCharm  = p.greeks?.charm  ?? null;
        entry.putDayVol     = p.day?.volume      ?? 0;
        entry.putPrevDayVol = p.prev_day?.volume ?? 0;
        entry.putVolumeRatio = entry.putPrevDayVol > 0
          ? parseFloat((entry.putDayVol / entry.putPrevDayVol).toFixed(2))
          : null;
        entry.putBlockTrade = isBlockTrade(p);
        entry.putIlliquid = ask > 0 && (ask - bid) / ask > 0.5;
      });

      const contracts = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

      // Phase 3: Volume-weighted IV (VWIV)
      let vwivCall = 0;
      let vwivPut = 0;
      let totalCallVol = 0;
      let totalPutVol = 0;

      contracts.forEach(c => {
        const cvol = c.callVolume ?? 0;
        const pvol = c.putVolume ?? 0;
        if (cvol > 0 && c.callIV > 0) {
          vwivCall += c.callIV * cvol;
          totalCallVol += cvol;
        }
        if (pvol > 0 && c.putIV > 0) {
          vwivPut += c.putIV * pvol;
          totalPutVol += pvol;
        }
      });

      vwivCall = totalCallVol > 0 ? parseFloat((vwivCall / totalCallVol).toFixed(1)) : null;
      vwivPut  = totalPutVol  > 0 ? parseFloat((vwivPut  / totalPutVol).toFixed(1))  : null;

      // Phase 3: OI concentration walls (top 5)
      const callOIWalls = contracts
        .filter(c => c.callOI > 0)
        .sort((a, b) => b.callOI - a.callOI)
        .slice(0, 5)
        .map(c => ({ strike: c.strike, oi: c.callOI }));

      const putOIWalls = contracts
        .filter(c => c.putOI > 0)
        .sort((a, b) => b.putOI - a.putOI)
        .slice(0, 5)
        .map(c => ({ strike: c.strike, oi: c.putOI }));

      // Phase 3: Block trade counts
      const blockCallCount = contracts.filter(c => c.callBlockTrade).length;
      const blockPutCount  = contracts.filter(c => c.putBlockTrade).length;

      // ── DIAGNOSTIC: Log gamma data status ──
      const gammaCount = contracts.filter(c => c.callGamma !== null || c.putGamma !== null).length;
      const sampleContracts = contracts.slice(0, 3).map(c => ({
        strike: c.strike,
        callGamma: c.callGamma,
        putGamma: c.putGamma,
        callDelta: c.callDelta,
        putDelta: c.putDelta,
      }));
      console.log(`[chain.js] Gamma status: ${gammaCount}/${contracts.length} contracts have gamma data`);
      console.log('[chain.js] Sample:', JSON.stringify(sampleContracts, null, 2));

      return res.status(200).json({
        symbol: sym,
        spot,
        spotVwap,
        spotChangePct,
        impliedMove,
        expiration: resolvedExpiration,
        contracts,
        // Phase 3 chain-level fields
        vwivCall,
        vwivPut,
        callOIWalls,
        putOIWalls,
        blockCallCount,
        blockPutCount,
        source: 'polygon-realtime',
      });

    } catch (error) {
      console.error('Error fetching options chain:', error);
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
        source: 'polygon-error',
      });
    }
  }

  // ─── No mode specified ────────────────────────────────────────────────────────
  return res.status(400).json({
    error: 'Either datesOnly=true, expiration, or allExpiries=true required',
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true  OR  /api/chain?symbol=TSLA&expiration=2026-06-20  OR  /api/chain?symbol=TSLA&allExpiries=true',
  });
};
