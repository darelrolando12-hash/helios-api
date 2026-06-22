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
      console.error(`[chain.js] Polygon HTTP ${res.status} on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      return null;
    }

    const data = await res.json();
    if (!data || data.status === 'ERROR') {
      console.error('[chain.js] Polygon returned error status:', data);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      return null;
    }

    return data;
  } catch (err) {
    console.error(`[chain.js] Fetch exception (attempt ${attempt}):`, err.message);
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    return null;
  }
}

// ─── Fetch spot price with fallback chain ────────────────────────────────────
async function fetchSpot(symbol, apiKey) {
  // Try snapshot endpoint first (has lastTrade.p and day.c)
  const snapUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${apiKey}`;
  const snapData = await polygonFetch(snapUrl);

  if (snapData?.ticker) {
    const t = snapData.ticker;
    // Priority: lastTrade.p → day.c → prevDay.c
    let spot = t.lastTrade?.p ?? t.day?.c ?? t.prevDay?.c ?? 0;
    let spotPrevClose = t.prevDay?.c ?? 0;
    let spotVwap = t.day?.vw ?? 0;

    if (spot > 0) {
      console.log(`[chain.js] Spot from snapshot: ${spot} (source: ${t.lastTrade?.p ? 'lastTrade.p' : t.day?.c ? 'day.c' : 'prevDay.c'})`);
      return { spot, spotPrevClose, spotVwap };
    }
  }

  // Fallback: previous close endpoint (works 24/7)
  console.log('[chain.js] Snapshot gave no spot, trying /v2/aggs/prev');
  const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`;
  const prevData = await polygonFetch(prevUrl);

  if (prevData?.results?.[0]) {
    const bar = prevData.results[0];
    const spot = bar.c ?? 0;
    const spotPrevClose = bar.c ?? 0; // prev close bar's close IS the prev close
    const spotVwap = bar.vw ?? 0;
    if (spot > 0) {
      console.log(`[chain.js] Spot from /v2/aggs/prev: ${spot}`);
      return { spot, spotPrevClose, spotVwap };
    }
  }

  console.error('[chain.js] All spot price sources failed — returning 0');
  return { spot: 0, spotPrevClose: 0, spotVwap: 0 };
}

// ─── Phase 3: Block trade detection ──────────────────────────────────────────
function isBlockTrade(contract) {
  // Polygon's "conditions" array may contain "41" for block trades, or check size
  if (contract.day?.conditions?.includes('41')) return true;
  // Also flag if single trade size > 100 contracts (institutional)
  const size = contract.last_trade?.size ?? 0;
  return size >= 100;
}

// ─── Phase 3: Volume-Weighted IV ─────────────────────────────────────────────
function computeVWIV(contracts, side) {
  let totalVol = 0;
  let weightedSum = 0;
  contracts.forEach(c => {
    const vol = side === 'call' ? c.callVolume : c.putVolume;
    const iv  = side === 'call' ? c.callIV : c.putIV;
    if (vol > 0 && iv > 0) {
      totalVol += vol;
      weightedSum += vol * iv;
    }
  });
  return totalVol > 0 ? parseFloat((weightedSum / totalVol).toFixed(1)) : null;
}

// ─── Phase 3: OI Concentration Walls ─────────────────────────────────────────
function findOIWalls(contracts, side) {
  const strikes = contracts
    .map(c => ({
      strike: c.strike,
      oi: side === 'call' ? c.callOI : c.putOI,
    }))
    .filter(x => x.oi > 0)
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 5);
  return strikes;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, expiration, datesOnly, allExpiries } = req.query;
  const apiKey = process.env.POLYGON_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }

  const sym = (symbol || '').toUpperCase();
  if (!sym) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  // ─── MODE 1: Dates only ───────────────────────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
      const data = await polygonFetch(url);
      if (!data?.results) {
        return res.status(200).json({ expiryDates: [] });
      }
      const uniqueDates = [...new Set(data.results.map(c => c.expiration_date))].sort();
      return res.status(200).json({ expiryDates: uniqueDates });
    } catch (error) {
      console.error('[chain.js] Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── MODE 2: Multi-expiry GEX stack ───────────────────────────────────────────
  if (allExpiries === 'true') {
    try {
      const refUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
      const refData = await polygonFetch(refUrl);
      if (!refData?.results) {
        return res.status(200).json({ expiries: [] });
      }
      const allDates = [...new Set(refData.results.map(c => c.expiration_date))].sort();
      const next5 = allDates.slice(0, 5);

      const spotResult = await fetchSpot(sym, apiKey);
      const spot = spotResult.spot;

      const expiryData = [];
      for (const exp of next5) {
        const snapUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?expiration_date.gte=${exp}&expiration_date.lte=${exp}&limit=250&apiKey=${apiKey}`;
        const snapData = await polygonFetch(snapUrl);
        if (!snapData?.results?.length) continue;

        const strikeGEX = new Map();
        snapData.results.forEach(opt => {
          const strike = opt.details?.strike_price;
          const gamma = opt.greeks?.gamma;
          const oi = opt.open_interest ?? 0;
          const type = opt.details?.contract_type;
          if (!strike || gamma == null || oi === 0) return;

          if (!strikeGEX.has(strike)) strikeGEX.set(strike, 0);
          const notional = gamma * oi * 100 * spot;
          strikeGEX.set(strike, strikeGEX.get(strike) + (type === 'call' ? notional : -notional));
        });

        const strikes = Array.from(strikeGEX.entries())
          .map(([strike, gex]) => ({ strike, gex }))
          .sort((a, b) => a.strike - b.strike);

        expiryData.push({ expiration: exp, strikes });
      }

      return res.status(200).json({ symbol: sym, spot, expiries: expiryData });
    } catch (error) {
      console.error('[chain.js] Error in allExpiries mode:', error);
      return res.status(200).json({ expiries: [] });
    }
  }

  // ─── MODE 3: Full chain for specific expiry ──────────────────────────────────
  if (expiration) {
    try {
      // Step 1: Validate expiry date via reference endpoint (works 24/7)
      const refUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expiration_date=${expiration}&limit=5&apiKey=${apiKey}`;
      const refData = await polygonFetch(refUrl);

      let resolvedExpiration = expiration;
      if (!refData?.results?.length) {
        console.log(`[chain.js] No contracts for ${expiration}, finding nearest valid date`);
        const allDatesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${apiKey}`;
        const allData = await polygonFetch(allDatesUrl);
        if (allData?.results?.length) {
          const allDates = [...new Set(allData.results.map(c => c.expiration_date))].sort();
          const target = new Date(expiration);
          let closest = allDates[0];
          let minDiff = Math.abs(new Date(allDates[0]) - target);
          for (const d of allDates) {
            const diff = Math.abs(new Date(d) - target);
            if (diff < minDiff) {
              minDiff = diff;
              closest = d;
            }
          }
          resolvedExpiration = closest;
          console.log(`[chain.js] Slid to nearest valid date: ${resolvedExpiration}`);
        }
      }

      // Step 2: Fetch spot price
      const spotResult = await fetchSpot(sym, apiKey);
      let spot = spotResult.spot;
      let spotPrevClose = spotResult.spotPrevClose;
      let spotVwap = spotResult.spotVwap;

      // Step 3: Fetch full options chain with pagination
      let callsResults = [];
      let putsResults = [];

      for (const type of ['call', 'put']) {
        let nextUrl = `https://api.polygon.io/v3/snapshot/options/${sym}/${type}?expiration_date.gte=${resolvedExpiration}&expiration_date.lte=${resolvedExpiration}&limit=250&apiKey=${apiKey}`;
        let page = 0;

        while (nextUrl && page < MAX_PAGES) {
          const data = await polygonFetch(nextUrl);
          if (!data?.results) break;

          if (type === 'call') callsResults.push(...data.results);
          else putsResults.push(...data.results);

          nextUrl = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
          page++;
        }
      }

      console.log(`[chain.js] Fetched ${callsResults.length} calls, ${putsResults.length} puts for ${resolvedExpiration}`);

      // If still no spot (e.g., symbol not in snapshot), try aggs/prev fallback
      if (spot === 0 && (callsResults.length > 0 || putsResults.length > 0)) {
        console.log('[chain.js] Spot still 0, trying final fallback /v2/aggs/prev');
        const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${apiKey}`;
        const fallback = await polygonFetch(prevUrl);
        if (fallback?.results?.[0]) {
          spot = fallback.results[0].c ?? 0;
          spotPrevClose = fallback.prevClose ?? spot;
          spotVwap = fallback.results[0].vw ?? 0;
        }
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
            // Bid/Ask/Last
            callBid: 0, callAsk: 0, callIV: 0, callOI: 0, callVolume: 0,
            callLast: 0, callDayVol: 0, callPrevDayVol: 0, callVolumeRatio: null,
            // Greeks (Phase 2)
            callDelta: null, callTheta: null, callGamma: null, callVega: null,
            // Phase 3 Greeks
            callVanna: null, callCharm: null,
            // Phase 3 extras
            callBlockTrade: false, callIlliquid: false,
            // Puts
            putBid: 0, putAsk: 0, putIV: 0, putOI: 0, putVolume: 0,
            putLast: 0, putDayVol: 0, putPrevDayVol: 0, putVolumeRatio: null,
            putDelta: null, putTheta: null, putGamma: null, putVega: null,
            putVanna: null, putCharm: null,
            putBlockTrade: false, putIlliquid: false,
            // ATM/ITM
            atm: false, itmCall: false, itmPut: false,
          });
        }
        return contractMap.get(strike);
      }

      // Process calls
      callsResults.forEach(c => {
        const strike = c.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);

        const bid  = c.market_data?.bid ?? 0;
        const ask  = c.market_data?.ask ?? 0;
        // Phase 3: prefer last_trade price for premium accuracy
        const lastTradePrice = c.market_data?.last_trade?.price
          ?? c.market_data?.last_quote?.midpoint
          ?? 0;

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
          ?? 0;

        entry.putBid    = bid;
        entry.putAsk    = ask;
        entry.putLast   = lastTradePrice;
        entry.putIV     = p.greeks?.implied_volatility != null
          ? parseFloat((p.greeks.implied_volatility * 100).toFixed(1))
          : 0;
        entry.putOI     = p.open_interest ?? 0;
        // Polygon puts daily volume in p.day.volume; p.volume is often 0 or missing
        entry.putVolume = p.day?.volume ?? p.volume ?? 0;
        entry.putDelta  = p.greeks?.delta  ?? null;
        entry.putTheta  = p.greeks?.theta  ?? null;
        entry.putGamma  = p.greeks?.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
        entry.putVega   = p.greeks?.vega   ?? null;
        // Phase 3 Greeks
        entry.putVanna  = p.greeks?.vanna  ?? null;
        entry.putCharm  = p.greeks?.charm  ?? null;
        entry.putDayVol     = p.day?.volume      ?? 0;
        entry.putPrevDayVol = p.prev_day?.volume ?? 0;
        entry.putVolumeRatio = entry.putPrevDayVol > 0
          ? parseFloat((entry.putDayVol / entry.putPrevDayVol).toFixed(2))
          : null;
        entry.putBlockTrade = isBlockTrade(p);
        entry.putIlliquid   = ask > 0 && (ask - bid) / ask > 0.5;
      });

      // ── ATM / ITM flags using real spot ─────────────────────────────────────
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

      // ── ATM straddle implied move ─────────────────────────────────────────────
      let impliedMove = null;
      if (spot > 0) {
        const atmEntry = contracts.find(c => c.atm);
        if (atmEntry) {
          const callMid = atmEntry.callBid > 0 && atmEntry.callAsk > 0
            ? (atmEntry.callBid + atmEntry.callAsk) / 2
            : atmEntry.callLast || 0;
          const putMid = atmEntry.putBid > 0 && atmEntry.putAsk > 0
            ? (atmEntry.putBid + atmEntry.putAsk) / 2
            : atmEntry.putLast || 0;
          if (callMid > 0 && putMid > 0) {
            impliedMove = parseFloat(((callMid + putMid) / spot * 100).toFixed(2));
          }
        }
      }

      // ── Phase 3: Volume-Weighted IV (VWIV) ──────────────────────────────────
      const vwivCall = computeVWIV(contracts, 'call');
      const vwivPut  = computeVWIV(contracts, 'put');

      // ── Phase 3: OI Concentration Walls ─────────────────────────────────────
      const callOIWalls = findOIWalls(contracts, 'call');
      const putOIWalls  = findOIWalls(contracts, 'put');

      // ── Phase 3: Block trade summary ────────────────────────────────────────
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
        callLast: c.callLast,
        putLast: c.putLast,
        callBid: c.callBid,
        callAsk: c.callAsk,
      }));
      console.log(`[chain.js] Gamma status: ${gammaCount}/${contracts.length} contracts have gamma data`);
      console.log('[chain.js] Sample (with Last Trade Price):', JSON.stringify(sampleContracts, null, 2));

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
