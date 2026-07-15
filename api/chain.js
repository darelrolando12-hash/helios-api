const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 400;
const MAX_PAGES = 10;

// ── ENV vars ─────────────────────────────────────────────────────────────────
const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Index ticker normalization — same as quote.js
const INDEX_TICKER_MAP = { SPX: 'I:SPX', SPXW: 'I:SPX', NDX: 'I:NDX', VIX: 'I:VIX' };

function toPolygonAggTicker(ticker) {
  if (ticker.startsWith('^')) return ticker.replace('^', 'I:');
  return INDEX_TICKER_MAP[ticker] ?? ticker;
}

function isIndexTicker(ticker) {
  return !!(INDEX_TICKER_MAP[ticker] || ticker.startsWith('^') || ticker.startsWith('I:'));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function polygonFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt * 2); // exponential: 800ms, 1600ms
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
    console.error('[chain.js] polygonFetch error after retries:', err.message);
    return null;
  }
}

// ── DB helper — read prev-day data from daily_market_data ────────────────────
// Eliminates /v2/aggs/prev calls when DB has fresh data.
// Same logic as quote.js readDBDailyData() — permanent rate-limit fix.

async function readDBDailyData(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=computed_date.desc&limit=1&select=*`;
    const r = await fetch(url, {
      headers: {
        'apikey':         SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    // Reject if data is older than 7 days
    const rowDate = new Date(row.computed_date + 'T00:00:00');
    const ageMs   = Date.now() - rowDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      console.warn(`[chain.js] DB daily_market_data stale for ${symbol} (${row.computed_date}) — falling back to Polygon`);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

// ── Fetch spot price and prev-day data — Yahoo-first, zero Stocks Basic calls ─
//
// PERMANENT FIX: /v2/last/stocks and /v2/aggs/prev are Stocks Basic endpoints (5 req/min).
// Yahoo Finance provides live price + prevClose for any ticker in one call.
// DB overlay (daily cron at 4:05 PM CT) provides precise prev-day vwap/OHLCV.

async function fetchSpot(ticker) {
  const sym = ticker.toUpperCase();

  // ── Step 1: DB prev-day overlay
  let prevClose = 0, prevVwap = 0;
  let prevFromDB = false;

  const dbRow = await readDBDailyData(sym);
  if (dbRow && dbRow.prev_close) {
    prevClose  = dbRow.prev_close ?? 0;
    prevVwap   = dbRow.prev_vwap  ?? 0;
    prevFromDB = true;
    console.log(`[chain.js] fetchSpot ${ticker}: prev-day from DB (${dbRow.computed_date}), prevClose=${prevClose}`);
  }

  // ── Step 2: Yahoo Finance for live price (and prevClose if DB missed)
  // Works for all tickers: equities (AAPL), ETFs (SPY), indices (SPX → ^GSPC, NDX → ^NDX).
  try {
    const yahooTicker = sym === 'SPX' || sym === 'SPXW' ? '^GSPC'
      : sym === 'NDX'  ? '^NDX'
      : sym === 'VIX'  ? '^VIX'
      : sym.startsWith('I:') ? '^' + sym.slice(2)
      : sym;
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1m&range=1d`;
    const yRes = await fetch(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)' } });
    if (yRes.ok) {
      const yData = await yRes.json();
      const meta = yData?.chart?.result?.[0]?.meta;
      if (meta) {
        const livePrice = meta.regularMarketPrice ?? 0;
        if (!prevFromDB) {
          prevClose = meta.previousClose ?? meta.chartPreviousClose ?? 0;
        }
        if (livePrice > 0) {
          console.log(`[chain.js] fetchSpot ${ticker}: live=${livePrice}, prevClose=${prevClose}, src=${prevFromDB ? 'yahoo+db' : 'yahoo'}`);
          return { spot: livePrice, vwap: prevVwap, prevClose };
        }
      }
    }
  } catch (yErr) {
    console.warn(`[chain.js] fetchSpot ${ticker}: Yahoo failed — ${yErr.message}`);
  }

  // ── Step 3: DB-only fallback
  console.log(`[chain.js] fetchSpot ${ticker}: Yahoo unavailable, using DB prevClose=${prevClose}`);
  return { spot: prevClose, vwap: prevVwap, prevClose };
}

// ─── GEX wall detection ──────────────────────────────────────────────────────

function findGEXWalls(contracts, currentSpot, isCall) {
  const withGEX = contracts
    .filter(c => isCall ? (c.callGEX ?? 0) !== 0 : (c.putGEX ?? 0) !== 0)
    .map(c => ({
      strike: c.strike,
      gex: isCall ? (c.callGEX ?? 0) : (c.putGEX ?? 0),
      dist: Math.abs(c.strike - currentSpot),
    }));

  if (withGEX.length === 0) return [];

  withGEX.sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex));
  const threshold = Math.abs(withGEX[0].gex) * 0.3;
  const significant = withGEX.filter(w => Math.abs(w.gex) >= threshold);
  significant.sort((a, b) => a.strike - b.strike);

  return significant
    .slice(0, 3)
    .map(w => ({ strike: w.strike, gex: w.gex, distPct: (w.dist / currentSpot) * 100 }));
}

// ─── VWIV (Volume-Weighted Implied Vol) ──────────────────────────────────────

function computeVWIV(contracts, isCall) {
  const relevant = contracts.filter(c => {
    const iv  = isCall ? c.callIV  : c.putIV;
    const vol = isCall ? c.callVol : c.putVol;
    return iv != null && vol != null && iv > 0 && vol > 0;
  });

  if (relevant.length === 0) return null;

  let sumIVxVol = 0;
  let sumVol = 0;
  for (const c of relevant) {
    const iv  = isCall ? c.callIV  : c.putIV;
    const vol = isCall ? c.callVol : c.putVol;
    sumIVxVol += iv * vol;
    sumVol += vol;
  }

  return sumVol > 0 ? parseFloat((sumIVxVol / sumVol).toFixed(2)) : null;
}

// ─── Block trade detection ───────────────────────────────────────────────────

function countBlockTrades(contracts) {
  let callBlocks = 0;
  let putBlocks = 0;

  for (const c of contracts) {
    // Block = lastSize > 100 contracts AND volume > 200
    if ((c.callLastSize ?? 0) > 100 && (c.callVol ?? 0) > 200) callBlocks++;
    if ((c.putLastSize ?? 0) > 100 && (c.putVol ?? 0) > 200) putBlocks++;
  }

  return { blockCallCount: callBlocks, blockPutCount: putBlocks };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  if (!POLYGON_KEY) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }

  const { symbol, expiration, datesOnly, allExpiries } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol query param required' });
  }

  const sym = symbol.toUpperCase();

  // ─── Mode 1: Return available expiry dates only ──────────────────────────────
  if (datesOnly === 'true') {
    try {
      const aggTicker = toPolygonAggTicker(sym);
      const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(aggTicker)}&limit=1000&apiKey=${POLYGON_KEY}`;
      const r = await polygonFetch(url);
      if (!r) return res.status(200).json({ symbol: sym, dates: [], source: 'polygon-error' });

      const data = await r.json();
      const contracts = data?.results ?? [];
      const uniqueDates = [...new Set(contracts.map(c => c.expiration_date))].sort();

      return res.status(200).json({
        symbol: sym,
        expiryDates: uniqueDates,
        dates: uniqueDates, // legacy compat
        count: uniqueDates.length,
        source: 'polygon-realtime',
      });
    } catch (error) {
      console.error('[chain.js] Error fetching expiry dates:', error);
      return res.status(200).json({ symbol: sym, dates: [], source: 'polygon-error' });
    }
  }

  // ─── Mode 2: Fetch full chain for one expiration ─────────────────────────────
  if (expiration) {
    try {
      const aggTicker = toPolygonAggTicker(sym);
      const spotData = await fetchSpot(sym);
      const spot = spotData.spot;
      const spotVwap = spotData.vwap;
      const spotPrevClose = spotData.prevClose;
      const spotChangePct = spotPrevClose > 0 ? ((spot - spotPrevClose) / spotPrevClose) * 100 : 0;

      let resolvedExpiration = expiration;

      // Try DB expiry_cache first
      if (SUPABASE_URL && SUPABASE_KEY) {
        try {
          const cacheUrl = `${SUPABASE_URL}/rest/v1/expiry_cache?symbol=eq.${encodeURIComponent(sym)}&select=dates`;
          const cacheRes = await fetch(cacheUrl, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          });
          if (cacheRes.ok) {
            const rows = await cacheRes.json();
            if (rows.length > 0 && Array.isArray(rows[0].dates)) {
              const cached = rows[0].dates.sort();
              const matchedDate = matchExpiryToRealDate(expiration, cached);
              if (matchedDate) {
                resolvedExpiration = matchedDate;
                console.log(`[chain.js] Expiry resolved from DB cache: ${expiration} → ${matchedDate}`);
              }
            }
          }
        } catch {}
      }

      // Build paginated requests
      const allResults = [];
      let nextUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(aggTicker)}&expiration_date=${resolvedExpiration}&limit=1000&apiKey=${POLYGON_KEY}`;

      for (let page = 0; page < MAX_PAGES && nextUrl; page++) {
        const r = await polygonFetch(nextUrl);
        if (!r) break;
        const data = await r.json();
        const results = data?.results ?? [];
        if (results.length === 0) break;
        allResults.push(...results);
        nextUrl = data?.next_url ? `${data.next_url}&apiKey=${POLYGON_KEY}` : null;
        if (nextUrl) await sleep(100);
      }

      if (allResults.length === 0) {
        return res.status(200).json({
          symbol: sym,
          spot,
          spotChangePct,
          expiration: resolvedExpiration,
          contracts: [],
          source: 'polygon-no-contracts',
        });
      }

      // Fetch snapshots with retry
      const snapUrl = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(aggTicker)}?apiKey=${POLYGON_KEY}`;
      let snapRes = await polygonFetch(snapUrl);
      if (!snapRes) {
        await sleep(300);
        snapRes = await polygonFetch(snapUrl);
      }
      const snapData = snapRes ? await snapRes.json() : null;
      const snapResults = snapData?.results ?? [];
      const snapMap = new Map();
      for (const s of snapResults) {
        if (s.details?.contract_type && s.details?.strike_price && s.details?.expiration_date === resolvedExpiration) {
          const key = `${s.details.strike_price}_${s.details.contract_type}`;
          snapMap.set(key, s);
        }
      }

      // Group by strike
      const strikeMap = new Map();
      for (const c of allResults) {
        if (!c.strike_price || c.expiration_date !== resolvedExpiration) continue;
        const strike = parseFloat(c.strike_price);
        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, { call: null, put: null });
        }
        const pair = strikeMap.get(strike);
        if (c.contract_type === 'call') pair.call = c;
        if (c.contract_type === 'put') pair.put = c;
      }

      const strikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
      const contracts = strikes.map(strike => {
        const pair = strikeMap.get(strike);
        const callSnap = snapMap.get(`${strike}_call`);
        const putSnap = snapMap.get(`${strike}_put`);

        const callOI = callSnap?.open_interest ?? pair.call?.open_interest ?? 0;
        const putOI = putSnap?.open_interest ?? pair.put?.open_interest ?? 0;

        const callVol = callSnap?.day?.volume ?? 0;
        const putVol = putSnap?.day?.volume ?? 0;

        const callBid = callSnap?.last_quote?.bid ?? 0;
        const callAsk = callSnap?.last_quote?.ask ?? 0;
        const callLast = callSnap?.last_trade?.price ?? 0;
        const callLastSize = callSnap?.last_trade?.size ?? null;
        // FIX 4: Pre-populate callMid so it's never undefined
        const callMid = callBid > 0 && callAsk > 0 ? (callBid + callAsk) / 2 : callBid || callAsk;

        const putBid = putSnap?.last_quote?.bid ?? 0;
        const putAsk = putSnap?.last_quote?.ask ?? 0;
        const putLast = putSnap?.last_trade?.price ?? 0;
        const putLastSize = putSnap?.last_trade?.size ?? null;
        // FIX 4: Pre-populate putMid so it's never undefined
        const putMid = putBid > 0 && putAsk > 0 ? (putBid + putAsk) / 2 : putBid || putAsk;

        const callIV = callSnap?.implied_volatility ?? null;
        const putIV = putSnap?.implied_volatility ?? null;

        const callDelta = callSnap?.greeks?.delta ?? null;
        const callGamma = callSnap?.greeks?.gamma ?? null;
        const callTheta = callSnap?.greeks?.theta ?? null;
        const callVega = callSnap?.greeks?.vega ?? null;

        const putDelta = putSnap?.greeks?.delta ?? null;
        const putGamma = putSnap?.greeks?.gamma ?? null;
        const putTheta = putSnap?.greeks?.theta ?? null;
        const putVega = putSnap?.greeks?.vega ?? null;

        const callGEX = callGamma != null && callOI > 0 ? callGamma * callOI * spot * spot * 0.01 : null;
        const putGEX = putGamma != null && putOI > 0 ? putGamma * putOI * spot * spot * 0.01 : null;

        return {
          strike,
          callOCC: pair.call?.ticker ?? null,
          putOCC: pair.put?.ticker ?? null,
          callOI,
          putOI,
          callVol,
          putVol,
          callBid,
          callAsk,
          callMid,
          callLast,
          callLastSize,
          putBid,
          putAsk,
          putMid,
          putLast,
          putLastSize,
          callIV,
          putIV,
          callDelta,
          callGamma,
          callTheta,
          callVega,
          putDelta,
          putGamma,
          putTheta,
          putVega,
          callGEX,
          putGEX,
        };
      });

      // GEX walls
      const callOIWalls = findGEXWalls(contracts, spot, true);
      const putOIWalls = findGEXWalls(contracts, spot, false);

      // VWIV
      const vwivCall = computeVWIV(contracts, true);
      const vwivPut = computeVWIV(contracts, false);

      // Block trades
      const { blockCallCount, blockPutCount } = countBlockTrades(contracts);

      // ATM straddle implied move (±1σ expected move)
      const atmStrike = strikes.reduce((prev, curr) =>
        Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
      );
      const atmContract = contracts.find(c => c.strike === atmStrike);
      let impliedMove = null;
      if (atmContract && atmContract.callLast > 0 && atmContract.putLast > 0) {
        const straddlePrice = atmContract.callLast + atmContract.putLast;
        impliedMove = parseFloat(((straddlePrice / spot) * 100).toFixed(2));
      }

      console.log(`[chain.js] ${sym} ${resolvedExpiration}: ${allResults.length} raw → ${contracts.length} strikes`);
      const gammaCount = contracts.filter(c => c.callGamma !== null || c.putGamma !== null).length;
      const sampleContracts = contracts.slice(0, 3).map(c => ({
        strike: c.strike,
        callOCC: c.callOCC,
        putOCC: c.putOCC,
        callBid: c.callBid, callAsk: c.callAsk, callLast: c.callLast,
        putBid: c.putBid, putAsk: c.putAsk, putLast: c.putLast,
        callGamma: c.callGamma, callDelta: c.callDelta,
      }));

      console.log(`[chain.js] Gamma: ${gammaCount}/${contracts.length} contracts have gamma`);
      console.log(`[chain.js] Spot: ${spot} (prevClose: ${spotPrevClose}, change: ${spotChangePct.toFixed(2)}%)`);
      console.log('[chain.js] Sample (with OCC symbols):', JSON.stringify(sampleContracts, null, 2));

      return res.status(200).json({
        symbol: sym,
        spot,
        spotVwap,
        spotChangePct,
        impliedMove,
        expiration: resolvedExpiration,
        contracts,
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
    usage: 'GET /api/chain?symbol=TSLA&datesOnly=true OR /api/chain?symbol=TSLA&expiration=2026-06-20 OR /api/chain?symbol=TSLA&allExpiries=true',
  });
}

function matchExpiryToRealDate(requested, realDates) {
  if (realDates.includes(requested)) return requested;
  const reqDate = new Date(requested + 'T00:00:00Z');
  if (isNaN(reqDate)) return null;
  const closest = realDates
    .map(d => ({ date: d, diff: Math.abs(new Date(d + 'T00:00:00Z') - reqDate) }))
    .sort((a, b) => a.diff - b.diff)[0];
  return closest && closest.diff < 7 * 24 * 60 * 60 * 1000 ? closest.date : null;
}
