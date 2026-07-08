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
    const date = row.date || '';
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (date !== today && date !== yesterday) return null;
    return row.prev_close || null;
  } catch (err) {
    console.error('[chain.js] getDBPrevClose error:', err);
    return null;
  }
}

async function fetchWithRetry(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        return fetchWithRetry(url, attempt + 1);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
}

async function fetchSpot(symbol, apiKey) {
  const dbPrev = await getDBPrevClose(symbol);
  if (dbPrev !== null) {
    return { price: dbPrev, changePct: 0 };
  }
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true&apiKey=${apiKey}`;
  const data = await fetchWithRetry(url);
  if (!data.results || data.results.length === 0) {
    return { price: 0, changePct: 0 };
  }
  const bar = data.results[0];
  return { price: bar.c || 0, changePct: 0 };
}

async function fetchExpiryDates(underlying, apiKey) {
  let allDates = [];
  let nextUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(underlying)}&limit=1000&apiKey=${apiKey}`;
  let pageCount = 0;

  while (nextUrl && pageCount < MAX_PAGES) {
    pageCount++;
    const data = await fetchWithRetry(nextUrl);
    if (data.results && Array.isArray(data.results)) {
      const dates = data.results
        .map(c => c.expiration_date)
        .filter(d => d && d.length === 10);
      allDates = allDates.concat(dates);
    }
    nextUrl = data.next_url
      ? `${data.next_url}&apiKey=${apiKey}`
      : null;
  }

  const uniqueDates = [...new Set(allDates)].sort();
  const today = new Date().toISOString().slice(0, 10);
  return uniqueDates.filter(d => d >= today);
}

function findNearestExpiry(requestedExpiry, availableDates) {
  if (!requestedExpiry || availableDates.length === 0) return null;
  if (availableDates.includes(requestedExpiry)) return requestedExpiry;

  const reqTime = new Date(requestedExpiry).getTime();
  let closest = availableDates[0];
  let minDiff = Math.abs(new Date(closest).getTime() - reqTime);

  for (const d of availableDates) {
    const diff = Math.abs(new Date(d).getTime() - reqTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = d;
    }
  }
  return closest;
}

async function fetchAllContractsForExpiry(underlying, expiry, apiKey) {
  let allContracts = [];
  let nextUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(underlying)}&expiration_date=${expiry}&limit=1000&apiKey=${apiKey}`;
  let pageCount = 0;

  while (nextUrl && pageCount < MAX_PAGES) {
    pageCount++;
    const data = await fetchWithRetry(nextUrl);
    if (data.results && Array.isArray(data.results)) {
      allContracts = allContracts.concat(data.results);
    }
    nextUrl = data.next_url
      ? `${data.next_url}&apiKey=${apiKey}`
      : null;
  }

  return allContracts;
}

async function fetchSnapshotForContracts(contractTickers, apiKey) {
  if (contractTickers.length === 0) return [];

  const batchSize = 250;
  const batches = [];
  for (let i = 0; i < contractTickers.length; i += batchSize) {
    batches.push(contractTickers.slice(i, i + batchSize));
  }

  const allSnapshots = [];
  for (const batch of batches) {
    const tickersParam = batch.join(',');
    const url = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(tickersParam)}?apiKey=${apiKey}`;
    try {
      const data = await fetchWithRetry(url);
      if (data.results && Array.isArray(data.results)) {
        allSnapshots.push(...data.results);
      }
    } catch (err) {
      console.error('[chain.js] Snapshot batch error:', err);
    }
  }

  return allSnapshots;
}

function computeIVFromRange(bid, ask, strike, spot, dte) {
  if (!bid || !ask || bid <= 0 || ask <= 0 || strike <= 0 || spot <= 0 || dte <= 0) return 0;
  const mid = (bid + ask) / 2;
  const intrinsic = Math.max(0, spot - strike);
  const extrinsic = Math.max(0, mid - intrinsic);
  const annualFactor = Math.sqrt(365 / dte);
  const rawIV = (extrinsic / spot) * annualFactor;
  return Math.max(0, Math.min(3.0, rawIV));
}

function isBlockTrade(conditions, size) {
  if (!conditions || !Array.isArray(conditions)) return false;
  if (conditions.includes(41)) return true;
  if (size && size >= 100) return true;
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = process.env.VITE_POLYGON_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'VITE_POLYGON_API_KEY not configured' });
  }

  const { symbol, datesOnly, expiration, allExpiries } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol query param required' });
  }

  const sym = symbol.toUpperCase();

  // ─── MODE 1: datesOnly ────────────────────────────────────────────────────────
  if (datesOnly === 'true') {
    try {
      const dates = await fetchExpiryDates(sym, apiKey);
      return res.status(200).json({ expiryDates: dates });
    } catch (error) {
      console.error('Error fetching expiry dates:', error);
      return res.status(200).json({ expiryDates: [] });
    }
  }

  // ─── MODE 3: allExpiries (multi-expiry GEX stack) ─────────────────────────────
  if (allExpiries === 'true') {
    try {
      const allDates = await fetchExpiryDates(sym, apiKey);
      if (allDates.length === 0) {
        return res.status(200).json({ expiries: [], symbol: sym });
      }

      const spot = await fetchSpot(sym, apiKey);
      const expiryResults = [];

      for (const exp of allDates.slice(0, 8)) {
        const contracts = await fetchAllContractsForExpiry(sym, exp, apiKey);
        const callTickers = contracts.filter(c => c.contract_type === 'call').map(c => c.ticker);
        const putTickers = contracts.filter(c => c.contract_type === 'put').map(c => c.ticker);

        const snapshots = await fetchSnapshotForContracts([...callTickers, ...putTickers], apiKey);
        const snapshotMap = new Map(snapshots.map(s => [s.details?.ticker, s]));

        let totalCallGEX = 0;
        let totalPutGEX = 0;

        for (const c of contracts) {
          const snap = snapshotMap.get(c.ticker);
          if (!snap) continue;

          const gamma = snap.greeks?.gamma || 0;
          const oi = snap.open_interest || 0;
          const gex = gamma * oi * 100 * spot.price * spot.price / 100;

          if (c.contract_type === 'call') {
            totalCallGEX += gex;
          } else {
            totalPutGEX += Math.abs(gex);
          }
        }

        expiryResults.push({
          expiry: exp,
          callGEX: totalCallGEX,
          putGEX: totalPutGEX,
          netGEX: totalCallGEX - totalPutGEX,
        });
      }

      return res.status(200).json({
        symbol: sym,
        spot: spot.price,
        expiries: expiryResults,
      });
    } catch (error) {
      console.error('Error fetching multi-expiry GEX:', error);
      return res.status(200).json({ expiries: [], symbol: sym });
    }
  }

  // ─── MODE 2: Full chain for single expiry ─────────────────────────────────────
  if (expiration) {
    try {
      const allDates = await fetchExpiryDates(sym, apiKey);
      if (allDates.length === 0) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot: 0, spotChangePct: 0,
          expiration, source: 'no-expiries',
        });
      }

      const resolvedExpiration = findNearestExpiry(expiration, allDates);
      if (!resolvedExpiration) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot: 0, spotChangePct: 0,
          expiration, source: 'no-valid-expiry',
        });
      }

      const contracts = await fetchAllContractsForExpiry(sym, resolvedExpiration, apiKey);
      if (contracts.length === 0) {
        return res.status(200).json({
          contracts: [], symbol: sym, spot: 0, spotChangePct: 0,
          expiration: resolvedExpiration, source: 'no-contracts',
        });
      }

      const callTickers = contracts.filter(c => c.contract_type === 'call').map(c => c.ticker);
      const putTickers = contracts.filter(c => c.contract_type === 'put').map(c => c.ticker);

      const snapshots = await fetchSnapshotForContracts([...callTickers, ...putTickers], apiKey);
      const snapshotMap = new Map(snapshots.map(s => [s.details?.ticker, s]));

      const callMap = new Map();
      const putMap = new Map();

      for (const c of contracts) {
        const strike = c.strike_price;
        if (!strike) continue;

        if (c.contract_type === 'call') {
          callMap.set(strike, c);
        } else if (c.contract_type === 'put') {
          putMap.set(strike, c);
        }
      }

      const allStrikes = new Set([...callMap.keys(), ...putMap.keys()]);
      const sortedStrikes = Array.from(allStrikes).sort((a, b) => a - b);

      const contractMap = new Map();

      function ensureStrike(strike) {
        if (!contractMap.has(strike)) {
          contractMap.set(strike, {
            strike,
            // OCC symbols for WebSocket subscription and bid/ask patching
            callOCC: null,
            putOCC: null,
            callBid: 0,
            callAsk: 0,
            callIV: 0,
            callOI: 0,
            callVolume: 0,
            callDelta: 0,
            callGamma: 0,
            callTheta: 0,
            callVanna: 0,
            callCharm: 0,
            callLast: 0,
            callIlliquid: false,
            callBlockTrade: false,
            putBid: 0,
            putAsk: 0,
            putIV: 0,
            putOI: 0,
            putVolume: 0,
            putDelta: 0,
            putGamma: 0,
            putTheta: 0,
            putVanna: 0,
            putCharm: 0,
            putLast: 0,
            putIlliquid: false,
            putBlockTrade: false,
          });
        }
        return contractMap.get(strike);
      }

      const spot = await fetchSpot(sym, apiKey);
      const spotPrice = spot.price;
      const spotChangePct = spot.changePct;

      const today = new Date().toISOString().slice(0, 10);
      const expiryDate = new Date(resolvedExpiration);
      const todayDate = new Date(today);
      const dte = Math.max(1, Math.ceil((expiryDate - todayDate) / 86400000));

      const sortedStrikesForAtm = sortedStrikes;
      const atmStrike = sortedStrikesForAtm.reduce((prev, curr) =>
        Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
      );
      const atmCallSnap = snapshotMap.get(callMap.get(atmStrike)?.ticker);
      const atmPutSnap = snapshotMap.get(putMap.get(atmStrike)?.ticker);

      const atmCallIV = atmCallSnap?.implied_volatility || 0;
      const atmPutIV = atmPutSnap?.implied_volatility || 0;
      const atmIV = atmCallIV > 0 && atmPutIV > 0 ? (atmCallIV + atmPutIV) / 2 : atmCallIV || atmPutIV;

      const impliedMove = atmIV > 0 && dte > 0
        ? spotPrice * atmIV * Math.sqrt(dte / 365)
        : 0;

      const spotVwap = 0;

      // Phase 3 chain-level fields
      const callIVByStrike = [];
      const putIVByStrike = [];
      const callOIByStrike = [];
      const putOIByStrike = [];
      let blockCallCount = 0;
      let blockPutCount = 0;

      for (const strike of sortedStrikes) {
        const entry = ensureStrike(strike);
        const c = callMap.get(strike);
        const p = putMap.get(strike);

        // ── CALLS ──
        if (c) {
          const snap = snapshotMap.get(c.ticker);
          if (snap) {
            const bid = snap.day?.open_interest > 0 ? (snap.day?.close || 0) : 0;
            const ask = snap.day?.open_interest > 0 ? (snap.day?.close || 0) : 0;
            const lastTradePrice = snap.last_trade?.price || 0;

            entry.callBid = bid;
            entry.callAsk = ask;
            entry.callLast = lastTradePrice;
            entry.callOCC = c.details?.ticker ?? null;

            if (snap.implied_volatility) {
              entry.callIV = snap.implied_volatility;
            } else if (bid > 0 && ask > 0) {
              entry.callIV = computeIVFromRange(bid, ask, strike, spotPrice, dte);
            }

            entry.callOI = snap.open_interest || 0;
            entry.callVolume = snap.day?.volume || 0;

            entry.callDelta = snap.greeks?.delta || 0;
            entry.callGamma = snap.greeks?.gamma || 0;
            entry.callTheta = snap.greeks?.theta || 0;
            entry.callVanna = snap.greeks?.vanna || 0;
            entry.callCharm = snap.greeks?.charm || 0;

            const spread = ask > 0 && bid > 0 ? (ask - bid) / ((ask + bid) / 2) : 0;
            entry.callIlliquid = spread > 0.5;

            entry.callBlockTrade = isBlockTrade(snap.last_trade?.conditions, snap.last_trade?.size);
            if (entry.callBlockTrade) blockCallCount++;

            if (entry.callIV > 0 && entry.callOI > 0) {
              callIVByStrike.push({ strike, iv: entry.callIV, oi: entry.callOI });
            }
            if (entry.callOI > 0) {
              callOIByStrike.push({ strike, oi: entry.callOI });
            }
          }
        }

        // ── PUTS ──
        if (p) {
          const snap = snapshotMap.get(p.ticker);
          if (snap) {
            const bid = snap.day?.open_interest > 0 ? (snap.day?.close || 0) : 0;
            const ask = snap.day?.open_interest > 0 ? (snap.day?.close || 0) : 0;
            const lastTradePrice = snap.last_trade?.price || 0;

            entry.putBid = bid;
            entry.putAsk = ask;
            entry.putLast = lastTradePrice;
            entry.putOCC = p.details?.ticker ?? null;

            if (snap.implied_volatility) {
              entry.putIV = snap.implied_volatility;
            } else if (bid > 0 && ask > 0) {
              entry.putIV = computeIVFromRange(bid, ask, strike, spotPrice, dte);
            }

            entry.putOI = snap.open_interest || 0;
            entry.putVolume = snap.day?.volume || 0;

            entry.putDelta = snap.greeks?.delta || 0;
            entry.putGamma = snap.greeks?.gamma || 0;
            entry.putTheta = snap.greeks?.theta || 0;
            entry.putVanna = snap.greeks?.vanna || 0;
            entry.putCharm = snap.greeks?.charm || 0;

            const spread = ask > 0 && bid > 0 ? (ask - bid) / ((ask + bid) / 2) : 0;
            entry.putIlliquid = spread > 0.5;

            entry.putBlockTrade = isBlockTrade(snap.last_trade?.conditions, snap.last_trade?.size);
            if (entry.putBlockTrade) blockPutCount++;

            if (entry.putIV > 0 && entry.putOI > 0) {
              putIVByStrike.push({ strike, iv: entry.putIV, oi: entry.putOI });
            }
            if (entry.putOI > 0) {
              putOIByStrike.push({ strike, oi: entry.putOI });
            }
          }
        }
      }

      // Volume-weighted IV (VWIV)
      let vwivCall = 0;
      let vwivPut = 0;
      const totalCallOI = callIVByStrike.reduce((sum, x) => sum + x.oi, 0);
      const totalPutOI = putIVByStrike.reduce((sum, x) => sum + x.oi, 0);

      if (totalCallOI > 0) {
        vwivCall = callIVByStrike.reduce((sum, x) => sum + (x.iv * x.oi), 0) / totalCallOI;
      }
      if (totalPutOI > 0) {
        vwivPut = putIVByStrike.reduce((sum, x) => sum + (x.iv * x.oi), 0) / totalPutOI;
      }

      // OI concentration walls (top 5)
      const callOIWalls = callOIByStrike
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 5)
        .map(x => ({ strike: x.strike, oi: x.oi }));

      const putOIWalls = putOIByStrike
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 5)
        .map(x => ({ strike: x.strike, oi: x.oi }));

      const finalContracts = Array.from(contractMap.values());

      // Diagnostic logging — verify callOCC/putOCC are present in Vercel logs
      const gammaCount = finalContracts.filter(c => c.callGamma > 0 || c.putGamma > 0).length;
      const sampleContracts = finalContracts.slice(0, 3).map(c => ({
        strike: c.strike,
        callOCC: c.callOCC,
        putOCC: c.putOCC,
        callGamma: c.callGamma,
        putGamma: c.putGamma,
        callDelta: c.callDelta,
        putDelta: c.putDelta,
        callLast: c.callLast,
        putLast: c.putLast,
        callBid: c.callBid,
        callAsk: c.callAsk,
      }));
      console.log(`[chain.js] Gamma status: ${gammaCount}/${finalContracts.length} contracts have gamma data`);
      console.log('[chain.js] Sample (with OCC symbols):', JSON.stringify(sampleContracts, null, 2));

      return res.status(200).json({
        symbol: sym,
        spot: spotPrice,
        spotVwap,
        spotChangePct,
        impliedMove,
        expiration: resolvedExpiration,
        contracts: finalContracts,
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
