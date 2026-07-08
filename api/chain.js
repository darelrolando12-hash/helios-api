const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;
const MAX_PAGES = 10;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// DB-first prevClose — eliminates /v2/aggs/prev in fetchSpot slow path
async function getDBPrevClose(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=date.desc&limit=1&select=prev_close,date`;
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    const rowDate = new Date(row.date + 'T00:00:00');
    if (Date.now() - rowDate.getTime() > 7 * 24 * 60 * 60 * 1000) return null;
    return row.prev_close ?? null;
  } catch {
    return null;
  }
}

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

    if (res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      console.error(`[chain.js] Polygon ${res.status} after all retries`);
      return null;
    }

    if (!res.ok) {
      console.warn(`[chain.js] Polygon non-OK ${res.status} for ${url}`);
      return null;
    }

    return res;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    console.error('[chain.js] Network error after all retries:', err.message);
    return null;
  }
}

async function fetchAllPages(initialUrl, _polygonKey) {
  const results = [];
  let url = initialUrl;
  let pageCount = 0;

  while (url && pageCount < MAX_PAGES) {
    const r = await polygonFetch(url);
    if (!r) break;

    let data;
    try { data = await r.json(); } catch { break; }

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

  // RATE LIMIT FIX: Accept pre-fetched spot price from centralDataStore.
  // When ?spot=NNN is passed, skip fetchSpot() entirely — saves 2 Polygon calls per chain fetch.
  // centralDataStore passes this from its already-cached quote data.
  const { symbol, datesOnly, expiration, allExpiries } = req.query;
  const preloadedSpot = req.query.spot ? parseFloat(req.query.spot) : null;
  const preloadedPrevClose = req.query.prevClose ? parseFloat(req.query.prevClose) : null;
  const preloadedVwap = req.query.vwap ? parseFloat(req.query.vwap) : null;

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

  // ─── Helper: fetch spot price — SKIPPED if preloadedSpot is provided ──────────
  // When centralDataStore passes ?spot=NNN, we skip this entirely (saves 2 calls/chain fetch).
  // Only called when chain.js is hit directly without spot data (e.g. allExpiries mode).
  // Index tickers: SPX/NDX use /v2/last/trade/I:SPX — NOT /v2/last/stocks (403 on indices)
  // VIX: returns 0 here — quote.js routes VIX through Yahoo Finance
  const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', SPXW: 'I:SPX' };
  // NOTE: VIX removed from INDEX_TICKER_MAP — VIX options are on SPX, chain.js never fetches VIX spot

  async function fetchSpot(ticker) {
    // FAST PATH: use pre-fetched data from centralDataStore (eliminates 2 Polygon calls)
    if (preloadedSpot && preloadedSpot > 0) {
      console.log(`[chain.js] fetchSpot ${ticker}: using preloaded spot=${preloadedSpot} (0 Polygon calls)`);
      return {
        price:     preloadedSpot,
        prevClose: preloadedPrevClose ?? preloadedSpot,
        vwap:      preloadedVwap ?? 0,
      };
    }

    // SLOW PATH: fetch from Polygon (only when chain.js is hit directly without spot data)
    try {
      const aggTicker = INDEX_TICKER_MAP[ticker] ?? ticker;

      // DB-first for prevClose — eliminates /v2/aggs/prev call when DB is warm
      let prevClose = await getDBPrevClose(ticker);
      let prevVwap = 0;

      if (!prevClose) {
        // DB miss — fetch from Polygon
        const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${aggTicker}/prev?adjusted=true&apiKey=${polygonKey}`;
        const prevR = await polygonFetch(prevUrl);
        if (prevR) {
          const prevData = await prevR.json();
          const bar = prevData?.results?.[0];
          if (bar) {
            prevClose = bar.c ?? 0;
            prevVwap = bar.vw ?? 0;
          }
        }
      }

      // Live last trade — index uses /v2/last/trade, equity uses /v2/last/stocks
      let livePrice = 0;
      try {
        const isIndex = !!INDEX_TICKER_MAP[ticker];
        const lastUrl = isIndex
          ? `https://api.polygon.io/v2/last/trade/${aggTicker}?apiKey=${polygonKey}`
          : `https://api.polygon.io/v2/last/stocks/${ticker}?apiKey=${polygonKey}`;
        const lastR = await polygonFetch(lastUrl);
        if (lastR) {
          const lastData = await lastR.json();
          livePrice = lastData?.results?.p ?? lastData?.last?.price ?? 0;
        }
      } catch { /* live price unavailable */ }

      const price = livePrice > 0 ? livePrice : prevClose;
      console.log(`[chain.js] fetchSpot ${ticker} (agg=${aggTicker}): livePrice=${livePrice}, prevClose=${prevClose}, using=${price}`);
      return { price, prevClose, vwap: prevVwap };
    } catch {
      return { price: 0, prevClose: 0, vwap: 0 };
    }
  }

  // ─── Helper: fetch all real expiry dates for a symbol ────────────────────────
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

  // ─── Helper: detect block trade from conditions array ─────────────────────────
  // Polygon condition "41" = "Trade Thru Exempt" / large institutional block
  // We also flag any last_trade.size > 50 contracts as a block print
  function isBlockTrade(contract) {
    const conditions = contract.day?.conditions ?? contract.market_data?.conditions ?? [];
    if (Array.isArray(conditions) && conditions.some(c => c === 41 || c === '41')) return true;
    const lastSize = contract.market_data?.last_trade?.size ?? 0;
    return lastSize >= 50;
  }

  // ─── Helper: compute volume-weighted IV for a side ───────────────────────────
  function computeVWIV(contracts, side) {
    // side = 'call' | 'put'
    let totalVol = 0;
    let weightedIV = 0;
    contracts.forEach(c => {
      const iv  = side === 'call' ? c.callIV  : c.putIV;
      const vol = side === 'call' ? c.callVolume : c.putVolume;
      if (iv > 0 && vol > 0) {
        weightedIV += iv * vol;
        totalVol   += vol;
      }
    });
    return totalVol > 0 ? parseFloat((weightedIV / totalVol).toFixed(1)) : null;
  }

  // ─── Helper: find top OI concentration walls ────────────────────────────────
  function findOIWalls(contracts, side) {
    const sorted = [...contracts]
      .filter(c => side === 'call' ? c.callOI > 0 : c.putOI > 0)
      .sort((a, b) => (side === 'call' ? b.callOI - a.callOI : b.putOI - a.putOI))
      .slice(0, 5);
    return sorted.map(c => ({
      strike: c.strike,
      oi: side === 'call' ? c.callOI : c.putOI,
    }));
  }

  // ─── MODE 1: Fetch available expiry dates ─────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const sortedDates = await fetchExpiryDates(sym);
      return res.status(200).json({ expiryDates: sortedDates, count: sortedDates.length });
    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── MODE 3: Multi-expiry GEX stack ──────────────────────────────────────────
  // Returns per-expiry GEX data across all upcoming expiries (for stacking)
  if (allExpiries === 'true') {
    try {
      const allDates = await fetchExpiryDates(sym);
      // Use CT date (America/Chicago) — not UTC which can be a day ahead during CT trading hours
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const upcoming = allDates.filter(d => d >= today).slice(0, 8); // next 8 expiries

      if (!upcoming.length) {
        return res.status(200).json({ symbol: sym, expiryGEX: [], source: 'polygon-empty' });
      }

      const { price: spot } = await fetchSpot(sym);

      const expiryGEX = await Promise.allSettled(
        upcoming.map(async (expDate) => {
          try {
            const callsUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${expDate}&limit=250&apiKey=${polygonKey}`;
            const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${expDate}&limit=250&apiKey=${polygonKey}`;
            const [calls, puts] = await Promise.all([
              fetchAllPages(callsUrl, polygonKey),
              fetchAllPages(putsUrl, polygonKey),
            ]);

            // Quick GEX per strike for this expiry
            const strikeMap = new Map();
            calls.forEach(c => {
              const strike = c.details?.strike_price;
              if (!strike) return;
              const oi    = c.open_interest ?? 0;
              const gamma = c.greeks?.gamma ?? 0;
              if (!strikeMap.has(strike)) strikeMap.set(strike, { strike, callGEX: 0, putGEX: 0 });
              strikeMap.get(strike).callGEX = oi * gamma * spot * spot * 100;
            });
            puts.forEach(p => {
              const strike = p.details?.strike_price;
              if (!strike) return;
              const oi    = p.open_interest ?? 0;
              const gamma = p.greeks?.gamma ?? 0;
              if (!strikeMap.has(strike)) strikeMap.set(strike, { strike, callGEX: 0, putGEX: 0 });
              strikeMap.get(strike).putGEX = oi * gamma * spot * spot * 100;
            });

            const strikes = Array.from(strikeMap.values()).map(s => ({
              strike: s.strike,
              netGEX: s.callGEX - s.putGEX,
            }));

            const totalNetGEX = strikes.reduce((sum, s) => sum + s.netGEX, 0);
            const dominantWall = strikes.reduce((best, s) =>
              Math.abs(s.netGEX) > Math.abs(best?.netGEX ?? 0) ? s : best, null);

            return { expiry: expDate, strikes, totalNetGEX, dominantWall };
          } catch {
            return null;
          }
        })
      );

      const results = expiryGEX
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

      return res.status(200).json({ symbol: sym, spot, expiryGEX: results, source: 'polygon-realtime' });
    } catch (error) {
      console.error('Error fetching multi-expiry GEX:', error);
      return res.status(200).json({ symbol: sym, expiryGEX: [], source: 'polygon-error' });
    }
  }

  // ─── MODE 2: Full options chain ───────────────────────────────────────────────
  if (expiration) {
    try {
      // ── Date validation: verify expiration exists using reference endpoint (works 24/7) ──
      let resolvedExpiration = expiration;

      // Use reference contracts endpoint — this works on weekends/after hours unlike snapshot
      const validDates = await fetchExpiryDates(sym);
      const isValidDate = validDates.includes(expiration);
      
      if (!isValidDate && validDates.length > 0) {
        console.warn(`[chain.js] ${expiration} not in expiry list for ${sym} — sliding to nearest`);
        const nearest = validDates.find(d => d >= expiration) ?? validDates[0];
        console.log(`[chain.js] Sliding expiration from ${expiration} → ${nearest} for ${sym}`);
        resolvedExpiration = nearest;
      }

      // ── Fetch all calls and puts with pagination ──────────────────────────────
      const callsBaseUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=call&expiration_date=${resolvedExpiration}&limit=250&apiKey=${polygonKey}`;
      const putsBaseUrl  = `https://api.polygon.io/v3/snapshot/options/${sym}?contract_type=put&expiration_date=${resolvedExpiration}&limit=250&apiKey=${polygonKey}`;

      const [callsResults, putsResults] = await Promise.all([
        fetchAllPages(callsBaseUrl, polygonKey),
        fetchAllPages(putsBaseUrl, polygonKey),
      ]);

      console.log(`[chain.js] ${sym} ${resolvedExpiration}: ${callsResults.length} calls, ${putsResults.length} puts fetched`);

      if (callsResults.length === 0 && putsResults.length === 0) {
        console.error(`[chain.js] Polygon returned zero contracts for ${sym} ${resolvedExpiration}`);
        // Still return spot price so UI can show LAST SESSION price even with no chain data
        const { price: spotForEmpty } = await fetchSpot(sym);
        return res.status(200).json({
          contracts: [],
          symbol: sym,
          spot: spotForEmpty,
          spotChangePct: 0,
          expiration: resolvedExpiration,
          source: 'polygon-empty',
        });
      }

      // ── Spot price extraction ────────────────────────────────────────────────
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

        // Polygon v3/snapshot/options: bid/ask live at top-level last_quote, NOT market_data
        const bid  = c.last_quote?.bid ?? c.market_data?.bid ?? 0;
        const ask  = c.last_quote?.ask ?? c.market_data?.ask ?? 0;
        const lastTradePrice = c.last_trade?.price
          ?? c.last_quote?.midpoint
          ?? c.market_data?.last_trade?.price
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
        const greeks = c.greeks ?? c.details?.greeks ?? {};
        entry.callDelta  = greeks.delta  ?? null;
        entry.callTheta  = greeks.theta  ?? null;
        entry.callGamma  = greeks.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
        entry.callVega   = greeks.vega   ?? null;
        // Phase 3 Greeks: vanna & charm
        entry.callVanna  = greeks.vanna  ?? null;
        entry.callCharm  = greeks.charm  ?? null;
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

        // Polygon v3/snapshot/options: bid/ask live at top-level last_quote, NOT market_data
        const bid  = p.last_quote?.bid ?? p.market_data?.bid ?? 0;
        const ask  = p.last_quote?.ask ?? p.market_data?.ask ?? 0;
        const lastTradePrice = p.last_trade?.price
          ?? p.last_quote?.midpoint
          ?? p.market_data?.last_trade?.price
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
