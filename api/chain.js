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

  const { symbol, datesOnly, expiration, allExpiries } = req.query;

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
  async function fetchSpot(ticker) {
    try {
      const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${polygonKey}`;
      const r = await polygonFetch(url);
      if (!r) return { price: 0, prevClose: 0, vwap: 0 };
      const data = await r.json();
      const t = data?.ticker;
      
      // Use the best available price — works during AND after market hours
      // lastTrade.p = live price during market hours
      // day.c = closing price (available after hours)
      // prevDay.c = previous session close (always available — including weekends)
      const price = t?.lastTrade?.p || t?.day?.c || t?.prevDay?.c || 0;
      const prevClose = t?.prevDay?.c || t?.day?.c || 0;
      const vwap = t?.day?.vw || 0;
      
      if (!price) {
        // Last resort: try Polygon's previous close endpoint
        const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polygonKey}`;
        const prevR = await polygonFetch(prevUrl);
        if (prevR) {
          const prevData = await prevR.json();
          const bar = prevData?.results?.[0];
          if (bar?.c) {
            return { price: bar.c, prevClose: bar.c, vwap: bar.vw || 0 };
          }
        }
      }
      
      return { price, prevClose, vwap };
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
      .sort((a, b) => {
        const aOI = side === 'call' ? a.callOI : a.putOI;
        const bOI = side === 'call' ? b.callOI : b.putOI;
        return bOI - aOI;
      })
      .slice(0, 5);
    return sorted.map(c => ({
      strike: c.strike,
      oi: side === 'call' ? c.callOI : c.putOI,
    }));
  }

  // ─── MODE 1: Expiry dates only ────────────────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const dates = await fetchExpiryDates(sym);
      return res.status(200).json({ expiryDates: dates });
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
      const { price: spot, prevClose, vwap: spotVwap } = await fetchSpot(sym);
      const spotChangePct = prevClose !== 0 ? ((spot - prevClose) / prevClose) * 100 : 0;

      // ── Map data to unified strike list ──────────────────────────────────────
      const strikeMap = new Map();

      const ensureStrike = (strike) => {
        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, {
            strike,
            callBid: 0, callAsk: 0, callLast: 0, callIV: 0, callOI: 0, callVolume: 0,
            callDelta: null, callTheta: null, callGamma: null, callVega: null,
            callVanna: null, callCharm: null,
            callDayVol: 0, callPrevDayVol: 0, callVolumeRatio: null,
            callBlockTrade: false, callIlliquid: false,
            putBid: 0, putAsk: 0, putLast: 0, putIV: 0, putOI: 0, putVolume: 0,
            putDelta: null, putTheta: null, putGamma: null, putVega: null,
            putVanna: null, putCharm: null,
            putDayVol: 0, putPrevDayVol: 0, putVolumeRatio: null,
            putBlockTrade: false, putIlliquid: false,
          });
        }
        return strikeMap.get(strike);
      };

      // Process calls
      callsResults.forEach(c => {
        const strike = c.details?.strike_price;
        if (!strike) return;
        const entry = ensureStrike(strike);

        const bid  = c.market_data?.bid ?? 0;
        const ask  = c.market_data?.ask ?? 0;
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
        entry.callDelta  = c.greeks?.delta  ?? null;
        entry.callTheta  = c.greeks?.theta  ?? null;
        entry.callGamma  = c.greeks?.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
        entry.callVega   = c.greeks?.vega   ?? null;
        // Phase 3 Greeks
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
        entry.putIlliquid = ask > 0 && (ask - bid) / ask > 0.5;
      });

      const contracts = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

      // ── Phase 3: Compute VWIV + OI walls ──────────────────────────────────────
      const vwivCall = computeVWIV(contracts, 'call');
      const vwivPut  = computeVWIV(contracts, 'put');
      const callOIWalls = findOIWalls(contracts, 'call');
      const putOIWalls  = findOIWalls(contracts, 'put');

      // ── Count block trades ────────────────────────────────────────────────────
      const blockCallCount = contracts.filter(c => c.callBlockTrade).length;
      const blockPutCount  = contracts.filter(c => c.putBlockTrade).length;

      // ── Compute implied move (ATM straddle IV × spot price × sqrt(DTE/365)) ──
      const atmStrike = contracts.reduce((best, c) =>
        Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best, contracts[0]);
      const atmCallIV = atmStrike?.callIV ?? 0;
      const atmPutIV  = atmStrike?.putIV  ?? 0;
      const straddleIV = (atmCallIV + atmPutIV) / 2;
      const expiryDate = new Date(resolvedExpiration);
      const now = new Date();
      const dte = Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)));
      const impliedMove = straddleIV > 0 && dte > 0
        ? spot * (straddleIV / 100) * Math.sqrt(dte / 365)
        : null;

      // ── Diagnostic: log gamma availability ────────────────────────────────────
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
