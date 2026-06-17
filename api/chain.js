const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function polygonFetch(url, attempt = 1) {
  try {
    const res = await fetch(url);

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[chain.js] Polygon 429 rate limit on attempt ${attempt}, retrying in ${RETRY_DELAY_MS * attempt}ms...`);
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      console.error('[chain.js] Polygon 429 after all retries');
      return null;
    }

    if (res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[chain.js] Polygon ${res.status} server error on attempt ${attempt}, retrying...`);
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      console.error(`[chain.js] Polygon ${res.status} after all retries`);
      return null;
    }

    if (!res.ok) {
      console.error(`[chain.js] Polygon non-retryable error: ${res.status} for ${url}`);
      return null;
    }

    return res;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      console.warn(`[chain.js] Network error on attempt ${attempt}: ${err.message}, retrying...`);
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    console.error(`[chain.js] Network error after all retries: ${err.message}`);
    return null;
  }
}

async function fetchAllPages(initialUrl, polygonKey) {
  const results = [];
  let url = initialUrl;
  let pageCount = 0;
  const MAX_PAGES = 10;

  while (url && pageCount < MAX_PAGES) {
    const fetchUrl = url.includes('apiKey') ? url : `${url}&apiKey=${polygonKey}`;
    const res = await polygonFetch(fetchUrl);
    if (!res) break;

    let data;
    try {
      data = await res.json();
    } catch {
      console.error('[chain.js] JSON parse error on page', pageCount + 1);
      break;
    }

    if (Array.isArray(data.results)) {
      results.push(...data.results);
    }

    url = data.next_url ?? null;
    pageCount++;

    if (url) await sleep(50);
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(`[chain.js] Hit MAX_PAGES cap (${MAX_PAGES}) — some contracts may be missing`);
  }

  return results;
}

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
      const r = await polygonFetch(url);
      if (!r) return { price: 0, prevClose: 0, vwap: 0 };
      const data = await r.json();
      const t = data?.ticker;
      const price     = t?.lastTrade?.p || t?.day?.c || t?.prevDay?.c || 0;
      const prevClose = t?.prevDay?.c || 0;
      const vwap      = t?.day?.vw || 0;
      return { price, prevClose, vwap };
    } catch {
      return { price: 0, prevClose: 0, vwap: 0 };
    }
  }

  async function fetchExpiryDates(ticker) {
    const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&limit=1000&apiKey=${polygonKey}`;
    const r = await polygonFetch(url);
    if (!r) return [];
    let data;
    try { data = await r.json(); } catch { return []; }
    if (!Array.isArray(data.results)) return [];
    const dates = new Set();
    data.results.forEach(c => { if (c.expiration_date) dates.add(c.expiration_date); });
    return Array.from(dates).sort();
  }

  // ── MODE 1: Expiry dates only ─────────────────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const sortedDates = await fetchExpiryDates(sym);
      return res.status(200).json({ expiryDates: sortedDates, count: sortedDates.length });
    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ── MODE 2: Full options chain ────────────────────────────────────────────────
  if (expiration) {
    try {
      // Date validation — slide to nearest real date if needed
      let resolvedExpiration = expiration;

      const callsCheckUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${expiration}&limit=1&apiKey=${polygonKey}`;
      const checkRes = await polygonFetch(callsCheckUrl);
      const checkData = checkRes ? await checkRes.json() : null;
      const hasContractsOnDate = Array.isArray(checkData?.results) && checkData.results.length > 0;

      if (!hasContractsOnDate) {
        console.warn(`[chain.js] No contracts found for ${sym} on ${expiration} — searching for nearest real date`);
        const allDates = await fetchExpiryDates(sym);
        if (allDates.length > 0) {
          const target = expiration;
          const nearest = allDates.find(d => d >= target) ?? allDates[0];
          if (nearest !== expiration) {
            console.log(`[chain.js] Sliding expiration from ${expiration} → ${nearest} for ${sym}`);
            resolvedExpiration = nearest;
          }
        }
      }

      // Fetch all calls + puts with full pagination
      const callsBaseUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${resolvedExpiration}&limit=250&apiKey=${polygonKey}`;
      const putsBaseUrl  = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${resolvedExpiration}&limit=250&apiKey=${polygonKey}`;

      const [callsResults, putsResults] = await Promise.all([
        fetchAllPages(callsBaseUrl, polygonKey),
        fetchAllPages(putsBaseUrl, polygonKey),
      ]);

      console.log(`[chain.js] ${sym} ${resolvedExpiration}: ${callsResults.length} calls, ${putsResults.length} puts fetched`);

      if (callsResults.length === 0 && putsResults.length === 0) {
        console.error(`[chain.js] Polygon returned zero contracts for ${sym} ${resolvedExpiration} after all retries`);
        return res.status(200).json({
          contracts: [],
          symbol: sym,
          spot: 0,
          spotChangePct: 0,
          expiration: resolvedExpiration,
          source: 'polygon-empty',
        });
      }

      // Spot price
      let spot = 0;
      let spotPrevClose = 0;
      let spotVwap = 0;

      const ua = callsResults[0]?.underlying_asset ?? putsResults[0]?.underlying_asset ?? null;

      if (ua && ua.price > 0) {
        spot = ua.price;
        spotPrevClose = ua.day?.prev_close ?? ua.day?.c ?? 0;
        spotVwap = ua.day?.vw ?? 0;
      }

      if (spot <= 0) {
        const fallback = await fetchSpot(sym);
        spot = fallback.price;
        spotPrevClose = fallback.prevClose;
        spotVwap = fallback.vwap ?? 0;
      }

      const spotChangePct = (spot > 0 && spotPrevClose > 0)
        ? ((spot - spotPrevClose) / spotPrevClose) * 100
        : 0;

      // Build contract map by strike
      const contractMap = new Map();

      function ensureStrike(strike) {
        if (!contractMap.has(strike)) {
          contractMap.set(strike, {
            strike,
            callBid: 0, callAsk: 0, callIV: 0,  callOI: 0,  callVolume: 0,
            callDelta: null, callTheta: null, callGamma: null, callVega: null,
            callLast: 0, callDayVol: 0, callPrevDayVol: 0, callVolumeRatio: null,
            putBid: 0,  putAsk: 0,  putIV: 0,   putOI: 0,   putVolume: 0,
            putDelta: null, putTheta: null, putGamma: null, putVega: null,
            putLast: 0, putDayVol: 0, putPrevDayVol: 0, putVolumeRatio: null,
            atm: false, itmCall: false, itmPut: false,
          });
        }
        return contractMap.get(strike);
      }

      callsResults.forEach(c => {
        const strike = c.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);
        entry.callBid    = c.market_data?.bid            ?? 0;
        entry.callAsk    = c.market_data?.ask            ?? 0;
        entry.callLast   = c.market_data?.last_trade?.price ?? c.market_data?.last_quote?.midpoint ?? 0;
        entry.callIV     = c.greeks?.implied_volatility != null
          ? parseFloat((c.greeks.implied_volatility * 100).toFixed(1)) : 0;
        entry.callOI     = c.open_interest               ?? 0;
        entry.callVolume = c.volume                      ?? 0;
        entry.callDelta  = c.greeks?.delta  ?? null;
        entry.callTheta  = c.greeks?.theta  ?? null;
        entry.callGamma  = c.greeks?.gamma  ?? null;
        entry.callVega   = c.greeks?.vega   ?? null;
        entry.callDayVol     = c.day?.volume         ?? 0;
        entry.callPrevDayVol = c.prev_day?.volume    ?? 0;
        entry.callVolumeRatio = entry.callPrevDayVol > 0
          ? parseFloat((entry.callDayVol / entry.callPrevDayVol).toFixed(2)) : null;
      });

      putsResults.forEach(p => {
        const strike = p.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);
        entry.putBid    = p.market_data?.bid            ?? 0;
        entry.putAsk    = p.market_data?.ask            ?? 0;
        entry.putLast   = p.market_data?.last_trade?.price ?? p.market_data?.last_quote?.midpoint ?? 0;
        entry.putIV     = p.greeks?.implied_volatility != null
          ? parseFloat((p.greeks.implied_volatility * 100).toFixed(1)) : 0;
        entry.putOI     = p.open_interest               ?? 0;
        entry.putVolume = p.volume                      ?? 0;
        entry.putDelta  = p.greeks?.delta  ?? null;
        entry.putTheta  = p.greeks?.theta  ?? null;
        entry.putGamma  = p.greeks?.gamma  ?? null;
        entry.putVega   = p.greeks?.vega   ?? null;
        entry.putDayVol     = p.day?.volume         ?? 0;
        entry.putPrevDayVol = p.prev_day?.volume    ?? 0;
        entry.putVolumeRatio = entry.putPrevDayVol > 0
          ? parseFloat((entry.putDayVol / entry.putPrevDayVol).toFixed(2)) : null;
      });

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

      // ATM straddle implied move
      let impliedMove = null;
      if (spot > 0) {
        const atmEntry = contracts.find(c => c.atm);
        if (atmEntry) {
          const callMid = atmEntry.callBid > 0 && atmEntry.callAsk > 0
            ? (atmEntry.callBid + atmEntry.callAsk) / 2 : atmEntry.callLast || 0;
          const putMid = atmEntry.putBid > 0 && atmEntry.putAsk > 0
            ? (atmEntry.putBid + atmEntry.putAsk) / 2 : atmEntry.putLast || 0;
          if (callMid > 0 && putMid > 0) {
            impliedMove = parseFloat(((callMid + putMid) / spot * 100).toFixed(2));
          }
        }
      }

      return res.status(200).json({
        symbol: sym,
        spot,
        spotVwap,
        spotChangePct,
        impliedMove,
        expiration: resolvedExpiration,
        contracts,
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

  return res.status(400).json({
    error: 'Either datesOnly=true or expiration parameter required',
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true  OR  GET /api/chain?symbol=TSLA&expiration=2026-06-20',
  });
};
