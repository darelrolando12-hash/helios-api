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
      throw new Error('Polygon rate limit exhausted');
    }

    if (!res.ok) {
      throw new Error(`Polygon API error: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    throw err;
  }
}

// Fetch Greeks snapshot from separate endpoint (no inline Supabase)
async function fetchGreeksSnapshot(symbol, expiry) {
  try {
    const API_BASE = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}` 
      : 'https://helios-gex.vercel.app';
    
    const res = await fetch(
      `${API_BASE}/api/greeks-snapshot?symbol=${symbol}&expiry=${expiry}`,
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!res.ok) {
      console.warn(`[chain.js] Greeks snapshot fetch failed: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    return data.snapshots || [];
  } catch (err) {
    console.error('[chain.js] Greeks snapshot error:', err.message);
    return [];
  }
}

// Enrich contracts with stored Greeks from database
function enrichWithStoredGreeks(contracts, snapshots) {
  if (!snapshots || snapshots.length === 0) return contracts;
  
  // Build lookup map: ticker -> greeks data
  const greeksMap = new Map();
  for (const snap of snapshots) {
    greeksMap.set(snap.ticker, {
      delta: snap.delta,
      gamma: snap.gamma,
      theta: snap.theta,
      vega: snap.vega,
      vanna: snap.vanna,
      charm: snap.charm,
      iv: snap.iv,
    });
  }
  
  // Enrich each contract
  return contracts.map(c => {
    const callGreeks = greeksMap.get(c.callTicker);
    const putGreeks = greeksMap.get(c.putTicker);
    
    return {
      ...c,
      // Call side
      callDelta: callGreeks?.delta ?? c.callDelta,
      callGamma: callGreeks?.gamma ?? c.callGamma,
      callTheta: callGreeks?.theta ?? c.callTheta,
      callVega: callGreeks?.vega ?? c.callVega,
      callVanna: callGreeks?.vanna ?? c.callVanna,
      callCharm: callGreeks?.charm ?? c.callCharm,
      callIV: callGreeks?.iv ?? c.callIV,
      // Put side
      putDelta: putGreeks?.delta ?? c.putDelta,
      putGamma: putGreeks?.gamma ?? c.putGamma,
      putTheta: putGreeks?.theta ?? c.putTheta,
      putVega: putGreeks?.vega ?? c.putVega,
      putVanna: putGreeks?.vanna ?? c.putVanna,
      putCharm: putGreeks?.charm ?? c.putCharm,
      putIV: putGreeks?.iv ?? c.putIV,
    };
  });
}

// CT market hours check (8:30 AM - 3:00 PM CT, weekdays)
function isMarketOpen() {
  const now = new Date();
  const ctTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ctTime.getDay();
  const hour = ctTime.getHours();
  const minute = ctTime.getMinutes();
  
  // Weekend
  if (day === 0 || day === 6) return false;
  
  // Before 8:30 AM CT
  if (hour < 8 || (hour === 8 && minute < 30)) return false;
  
  // After 3:00 PM CT
  if (hour >= 15) return false;
  
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, expiration, datesOnly, allExpiries } = req.query;
  const POLYGON_KEY = process.env.POLYGON_API_KEY;

  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_API_KEY missing' });

  const sym = symbol.toUpperCase().trim();

  try {
    // ─── MODE 1: Expiry dates only ──────────────────────────────────────────────
    if (datesOnly === 'true') {
      const refUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=1000&apiKey=${POLYGON_KEY}`;
      const refJson = await polygonFetch(refUrl);
      const allContracts = refJson?.results || [];
      const uniqueDates = [...new Set(allContracts.map(c => c.expiration_date))].sort();
      return res.status(200).json({ 
        symbol: sym, 
        expiryDates: uniqueDates,
        source: 'polygon-realtime',
      });
    }

    // ─── MODE 2 & 3: Full chain data ────────────────────────────────────────────
    if (!expiration) return res.status(400).json({ error: 'expiration required' });

    // Step 1: Get ALL contract references for the symbol with pagination
    let allContracts = [];
    let nextRefUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expiration_date=${expiration}&limit=1000&apiKey=${POLYGON_KEY}`;
    let refPageCount = 0;

    while (nextRefUrl && refPageCount < MAX_PAGES) {
      const refJson = await polygonFetch(nextRefUrl);
      const results = refJson?.results || [];
      allContracts.push(...results);
      nextRefUrl = refJson?.next_url ? `${refJson.next_url}&apiKey=${POLYGON_KEY}` : null;
      refPageCount++;
    }
    
    if (allContracts.length === 0) {
      return res.status(200).json({
        contracts: [], 
        symbol: sym, 
        spot: 0, 
        spotChangePct: 0, 
        expiration,
        source: 'polygon-no-contracts',
      });
    }

    // Step 2: Validate expiration date exists, auto-slide to nearest if not
    const availableDates = [...new Set(allContracts.map(c => c.expiration_date))].sort();
    let resolvedExpiration = expiration;
    if (!availableDates.includes(expiration)) {
      console.warn(`[chain.js] Invalid expiration ${expiration}, available:`, availableDates.slice(0, 5));
      const nearest = availableDates.reduce((prev, curr) =>
        Math.abs(new Date(curr) - new Date(expiration)) < Math.abs(new Date(prev) - new Date(expiration)) ? curr : prev
      );
      resolvedExpiration = nearest;
      console.log(`[chain.js] Auto-slid to nearest date: ${resolvedExpiration}`);
    }

    console.log(`[chain.js] ${sym} ${resolvedExpiration}: fetched ${allContracts.length} contracts in ${refPageCount} page(s)`);

    // Step 3: Fetch REAL snapshot data from Polygon (with pagination + retry)
    let allSnapshots = [];
    let nextUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?limit=250&apiKey=${POLYGON_KEY}`;
    let pageCount = 0;

    while (nextUrl && pageCount < MAX_PAGES) {
      const snapshotJson = await polygonFetch(nextUrl);
      const results = snapshotJson?.results || [];
      
      // Filter to match target expiration
      const filtered = results.filter(s => s.details?.expiration_date === resolvedExpiration);
      allSnapshots.push(...filtered);
      
      nextUrl = snapshotJson?.next_url ? `${snapshotJson.next_url}&apiKey=${POLYGON_KEY}` : null;
      pageCount++;
      console.log(`[chain.js] Fetched page ${pageCount}: ${filtered.length}/${results.length} contracts matched expiry (total: ${allSnapshots.length})`);
    }

    if (allSnapshots.length === 0) {
      console.warn('[chain.js] No snapshots returned from Polygon');
      return res.status(200).json({
        contracts: [], 
        symbol: sym, 
        spot: 0, 
        spotChangePct: 0, 
        expiration: resolvedExpiration,
        source: 'polygon-no-snapshots',
      });
    }

    // Step 4: Get spot price — DIRECT POLYGON CALL (no middleman, no amplification)
    const quoteUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?apiKey=${POLYGON_KEY}`;
    const quoteJson = await polygonFetch(quoteUrl);
    const spot = quoteJson?.results?.[0]?.c ?? 0;
    const spotVwap = quoteJson?.results?.[0]?.vw ?? spot;
    const spotOpen = quoteJson?.results?.[0]?.o ?? spot;
    const spotChangePct = spotOpen !== 0 ? ((spot - spotOpen) / spotOpen) * 100 : 0;

    console.log(`[chain.js] ${sym} spot price: $${spot.toFixed(2)} (${spotChangePct >= 0 ? '+' : ''}${spotChangePct.toFixed(2)}%)`);

    // Step 5: Merge calls and puts by strike
    const calls = allSnapshots.filter(s => s.details?.contract_type === 'call');
    const puts = allSnapshots.filter(s => s.details?.contract_type === 'put');

    const contractMap = new Map();

    // Initialize all strikes from reference contracts
    for (const contract of allContracts) {
      const strike = contract.strike_price;
      if (!contractMap.has(strike)) {
        contractMap.set(strike, {
          strike,
          callBid: 0, callAsk: 0, callLast: 0, callIV: 0, callOI: 0, callVolume: 0,
          callDelta: null, callGamma: null, callTheta: null, callVega: null,
          callVanna: null, callCharm: null,
          putBid: 0, putAsk: 0, putLast: 0, putIV: 0, putOI: 0, putVolume: 0,
          putDelta: null, putGamma: null, putTheta: null, putVega: null,
          putVanna: null, putCharm: null,
          callTicker: null, putTicker: null,
          callIlliquid: false, putIlliquid: false,
          callBlockTrade: false, putBlockTrade: false,
        });
      }
    }

    // Enrich with CALL data
    for (const c of calls) {
      const strike = c.details?.strike_price;
      if (!strike || !contractMap.has(strike)) continue;
      
      const entry = contractMap.get(strike);
      const day = c.day || {};
      const greeks = c.greeks || {};
      
      // Check if block trade (condition 41 or size > 100 contracts)
      const isBlockTrade = (c.last_quote?.conditions || []).includes('41') || 
                           (day.volume || 0) > 100;
      
      // Check liquidity (spread > 50% of mid)
      const bid = c.last_quote?.bid ?? 0;
      const ask = c.last_quote?.ask ?? 0;
      const mid = (bid + ask) / 2;
      const spread = ask - bid;
      const isIlliquid = mid > 0 && (spread / mid) > 0.5;

      contractMap.set(strike, {
        ...entry,
        callTicker: c.details?.ticker,
        callBid: bid,
        callAsk: ask,
        callLast: c.last_trade?.price ?? 0,
        callIV: greeks.implied_volatility ?? 0,
        callDelta: greeks.delta ?? null,
        callGamma: greeks.gamma ?? null,
        callTheta: greeks.theta ?? null,
        callVega: greeks.vega ?? null,
        callVanna: greeks.vanna ?? null,
        callCharm: greeks.charm ?? null,
        callOI: c.open_interest ?? 0,
        callVolume: day.volume ?? 0,
        callIlliquid: isIlliquid,
        callBlockTrade: isBlockTrade,
      });
    }

    // Enrich with PUT data
    for (const p of puts) {
      const strike = p.details?.strike_price;
      if (!strike || !contractMap.has(strike)) continue;
      
      const entry = contractMap.get(strike);
      const day = p.day || {};
      const greeks = p.greeks || {};
      
      const isBlockTrade = (p.last_quote?.conditions || []).includes('41') || 
                           (day.volume || 0) > 100;
      
      const bid = p.last_quote?.bid ?? 0;
      const ask = p.last_quote?.ask ?? 0;
      const mid = (bid + ask) / 2;
      const spread = ask - bid;
      const isIlliquid = mid > 0 && (spread / mid) > 0.5;

      contractMap.set(strike, {
        ...entry,
        putTicker: p.details?.ticker,
        putBid: bid,
        putAsk: ask,
        putLast: p.last_trade?.price ?? 0,
        putIV: greeks.implied_volatility ?? 0,
        putDelta: greeks.delta ?? null,
        putGamma: greeks.gamma ?? null,
        putTheta: greeks.theta ?? null,
        putVega: greeks.vega ?? null,
        putVanna: greeks.vanna ?? null,
        putCharm: greeks.charm ?? null,
        putOI: p.open_interest ?? 0,
        putVolume: day.volume ?? 0,
        putIlliquid: isIlliquid,
        putBlockTrade: isBlockTrade,
      });
    }

    let contracts = Array.from(contractMap.values()).sort((a, b) => a.strike - b.strike);

    // Step 6: Market hours detection + Greeks enrichment
    const marketOpen = isMarketOpen();
    let dataSource = 'polygon-realtime';

    if (!marketOpen) {
      console.log('[chain.js] Market closed - fetching stored Greeks for enrichment');
      const snapshots = await fetchGreeksSnapshot(sym, resolvedExpiration);
      if (snapshots.length > 0) {
        contracts = enrichWithStoredGreeks(contracts, snapshots);
        dataSource = 'polygon-last-session';
        console.log(`[chain.js] Enriched ${contracts.length} contracts with ${snapshots.length} stored Greeks`);
      } else {
        console.log('[chain.js] No stored Greeks found for after-hours enrichment');
      }
    }

    // Phase 3: VWIV, OI walls, block trade counts
    let vwivCall = 0, vwivPut = 0;
    let totalCallVol = 0, totalPutVol = 0;

    for (const c of contracts) {
      if (c.callVolume > 0 && c.callIV > 0) {
        vwivCall += c.callIV * c.callVolume;
        totalCallVol += c.callVolume;
      }
      if (c.putVolume > 0 && c.putIV > 0) {
        vwivPut += c.putIV * c.putVolume;
        totalPutVol += c.putVolume;
      }
    }

    vwivCall = totalCallVol > 0 ? vwivCall / totalCallVol : 0;
    vwivPut = totalPutVol > 0 ? vwivPut / totalPutVol : 0;

    // OI walls (top 5 strikes by OI)
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

    const blockCallCount = contracts.filter(c => c.callBlockTrade).length;
    const blockPutCount = contracts.filter(c => c.putBlockTrade).length;

    // Implied move (ATM straddle approximation)
    const atmStrike = contracts.reduce((prev, curr) =>
      Math.abs(curr.strike - spot) < Math.abs(prev.strike - spot) ? curr : prev
    ).strike;
    const atmContract = contracts.find(c => c.strike === atmStrike);
    const straddlePremium = atmContract ? (atmContract.callBid + atmContract.callAsk) / 2 + (atmContract.putBid + atmContract.putAsk) / 2 : 0;
    const impliedMove = spot !== 0 ? (straddlePremium / spot) * 100 : 0;

    // Step 7: Diagnostics
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
      source: dataSource,
    });

  } catch (error) {
    console.error('Error fetching options chain:', error);
    return res.status(200).json({
      contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
      source: 'polygon-error',
    });
  }
};
