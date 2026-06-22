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
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        return polygonFetch(url, attempt + 1);
      }
      console.error(`[chain.js] Polygon returned ${res.status} after all retries`);
      return null;
    }

    const json = await res.json();
    return json;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return polygonFetch(url, attempt + 1);
    }
    console.error('[chain.js] Polygon fetch failed after all retries:', err);
    return null;
  }
}

/**
 * Check if market is currently open (8:30 AM - 3:00 PM CT on weekdays)
 */
function isMarketOpen() {
  const now = new Date();
  
  // Convert to CT (America/Chicago)
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay(); // 0=Sunday, 6=Saturday
  const hour = ct.getHours();
  const minute = ct.getMinutes();
  
  // Weekend check
  if (day === 0 || day === 6) return false;
  
  // Weekday hours: 8:30 AM - 3:00 PM CT
  const timeInMinutes = hour * 60 + minute;
  const marketOpen = 8 * 60 + 30;  // 8:30 AM
  const marketClose = 15 * 60;      // 3:00 PM
  
  return timeInMinutes >= marketOpen && timeInMinutes < marketClose;
}

/**
 * Fetch stored Greeks from database via separate endpoint
 */
async function fetchGreeksSnapshot(symbol, expiry) {
  try {
    const baseUrl = process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}`
      : 'https://helios-api-six.vercel.app';
    
    const url = `${baseUrl}/api/greeks-snapshot?symbol=${symbol}&expiry=${expiry}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      console.error(`[chain.js] Greeks snapshot fetch failed: ${res.status}`);
      return [];
    }
    
    const json = await res.json();
    return json.snapshots || [];
  } catch (err) {
    console.error('[chain.js] Error fetching Greeks snapshot:', err);
    return [];
  }
}

/**
 * Enrich contracts array with stored Greeks from database
 */
function enrichWithStoredGreeks(contracts, snapshots) {
  if (!snapshots || snapshots.length === 0) {
    console.log('[chain.js] No Greeks snapshots available for enrichment');
    return contracts;
  }

  // Build lookup map by strike
  const greeksMap = new Map();
  for (const snap of snapshots) {
    greeksMap.set(snap.strike, snap);
  }

  let enrichedCount = 0;
  
  // Merge Greeks into contracts
  for (const contract of contracts) {
    const stored = greeksMap.get(contract.strike);
    if (!stored) continue;

    // Only enrich if current data is missing Greeks
    if (contract.callDelta === null && stored.call_delta !== null) {
      contract.callDelta = stored.call_delta;
      contract.callTheta = stored.call_theta;
      contract.callGamma = stored.call_gamma;
      contract.callVega = stored.call_vega;
      contract.callVanna = stored.call_vanna;
      contract.callCharm = stored.call_charm;
      enrichedCount++;
    }
    
    if (contract.putDelta === null && stored.put_delta !== null) {
      contract.putDelta = stored.put_delta;
      contract.putTheta = stored.put_theta;
      contract.putGamma = stored.put_gamma;
      contract.putVega = stored.put_vega;
      contract.putVanna = stored.put_vanna;
      contract.putCharm = stored.put_charm;
      enrichedCount++;
    }
  }

  console.log(`[chain.js] Enriched ${enrichedCount} contracts with stored Greeks`);
  return contracts;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbol, expiration, datesOnly, allExpiries } = req.query;
  const sym = (symbol || '').toUpperCase().trim();

  if (!sym) {
    return res.status(400).json({ error: 'symbol required' });
  }

  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  if (!POLYGON_KEY) {
    console.error('[chain.js] POLYGON_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Mode 1: Dates only
  if (datesOnly === 'true') {
    const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const json = await polygonFetch(url);
    if (!json || !json.results || json.results.length === 0) {
      return res.status(200).json({ expiryDates: [] });
    }
    const dates = [...new Set(json.results.map(r => r.expiration_date))].sort();
    return res.status(200).json({ expiryDates: dates });
  }

  // Mode 2: Multi-expiry GEX stack
  if (allExpiries === 'true') {
    const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const datesJson = await polygonFetch(datesUrl);
    if (!datesJson || !datesJson.results || datesJson.results.length === 0) {
      return res.status(200).json({ expiries: [] });
    }

    const allDates = [...new Set(datesJson.results.map(r => r.expiration_date))].sort();
    const targetExpiries = allDates.slice(0, 5);
    const marketOpen = isMarketOpen();
    const result = [];

    for (const expiry of targetExpiries) {
      let allContracts = [];
      let contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expiration_date=${expiry}&limit=1000&apiKey=${POLYGON_KEY}`;
      let pageCount = 0;

      while (contractsUrl && pageCount < MAX_PAGES) {
        const contractsJson = await polygonFetch(contractsUrl);
        if (!contractsJson || !contractsJson.results) break;
        allContracts = allContracts.concat(contractsJson.results);
        contractsUrl = contractsJson.next_url ? `${contractsJson.next_url}&apiKey=${POLYGON_KEY}` : null;
        pageCount++;
      }

      const tickers = allContracts.map(r => r.ticker);
      
      // Use chain snapshot endpoint (single call for all contracts)
      const snapshotUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?apiKey=${POLYGON_KEY}`;
      const snapshotJson = await polygonFetch(snapshotUrl);
      
      let allSnapshots = [];
      if (snapshotJson && snapshotJson.results) {
        // Filter to only this expiry
        allSnapshots = snapshotJson.results.filter(s => 
          s.details.expiration_date === expiry
        );
      }

      let gexData = allSnapshots.map(s => ({
        strike: s.details.strike_price,
        callGamma: s.greeks?.gamma || null,
        putGamma: s.greeks?.gamma || null,
        callOI: s.open_interest || 0,
        putOI: s.open_interest || 0,
      }));

      // NEW: If market closed and gamma is null, enrich with stored Greeks
      if (!marketOpen) {
        const snapshots = await fetchGreeksSnapshot(sym, expiry);
        if (snapshots.length > 0) {
          const greeksMap = new Map();
          for (const snap of snapshots) {
            greeksMap.set(snap.strike, snap);
          }

          for (const contract of gexData) {
            const stored = greeksMap.get(contract.strike);
            if (!stored) continue;
            
            if (contract.callGamma === null && stored.call_gamma !== null) {
              contract.callGamma = stored.call_gamma;
            }
            if (contract.putGamma === null && stored.put_gamma !== null) {
              contract.putGamma = stored.put_gamma;
            }
          }
        }
      }

      // Convert null to 0 for GEX calculations
      gexData = gexData.map(c => ({
        ...c,
        callGamma: c.callGamma ?? 0,
        putGamma: c.putGamma ?? 0,
      }));

      result.push({ expiry, contracts: gexData });
    }

    return res.status(200).json({ 
      expiries: result,
      source: marketOpen ? 'polygon-realtime' : 'polygon-last-session'
    });
  }

  // Mode 3: Single expiry full chain
  if (!expiration) {
    return res.status(400).json({ error: 'expiration required' });
  }

  try {
    // Step 1: Validate expiration date
    const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const datesJson = await polygonFetch(datesUrl);

    if (!datesJson || !datesJson.results || datesJson.results.length === 0) {
      console.log('[chain.js] No contracts found for', sym);
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
        source: 'polygon-no-data',
      });
    }

    const allDates = [...new Set(datesJson.results.map(r => r.expiration_date))].sort();
    let resolvedExpiration = expiration;

    if (!allDates.includes(expiration)) {
      const targetDate = new Date(expiration);
      const closest = allDates.reduce((prev, curr) => {
        const prevDiff = Math.abs(new Date(prev) - targetDate);
        const currDiff = Math.abs(new Date(curr) - targetDate);
        return currDiff < prevDiff ? curr : prev;
      });
      resolvedExpiration = closest;
      console.log(`[chain.js] Auto-slid ${expiration} → ${resolvedExpiration}`);
    }

    // Step 2: Fetch all contracts with pagination
    let allContracts = [];
    let contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expiration_date=${resolvedExpiration}&limit=1000&apiKey=${POLYGON_KEY}`;
    let pageCount = 0;

    while (contractsUrl && pageCount < MAX_PAGES) {
      const contractsJson = await polygonFetch(contractsUrl);
      if (!contractsJson || !contractsJson.results) break;
      allContracts = allContracts.concat(contractsJson.results);
      contractsUrl = contractsJson.next_url ? `${contractsJson.next_url}&apiKey=${POLYGON_KEY}` : null;
      pageCount++;
    }

    if (allContracts.length === 0) {
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration: resolvedExpiration,
        source: 'polygon-no-contracts',
      });
    }

    // Step 3: Fetch ALL snapshots using chain snapshot endpoint (single call)
    const snapshotUrl = `https://api.polygon.io/v3/snapshot/options/${sym}?apiKey=${POLYGON_KEY}`;
    const snapshotJson = await polygonFetch(snapshotUrl);
    
    if (!snapshotJson || !snapshotJson.results) {
      console.log('[chain.js] No snapshot data returned from Polygon');
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration: resolvedExpiration,
        source: 'polygon-no-snapshots',
      });
    }
    
    // Filter snapshots to match our target expiration
    const allSnapshots = snapshotJson.results.filter(s => 
      s.details.expiration_date === resolvedExpiration
    );

    // Step 4: Get spot price
    const quoteUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?apiKey=${POLYGON_KEY}`;
    const quoteJson = await polygonFetch(quoteUrl);
    const spot = quoteJson?.results?.[0]?.c ?? 0;
    const spotVwap = quoteJson?.results?.[0]?.vw ?? spot;
    const spotOpen = quoteJson?.results?.[0]?.o ?? spot;
    const spotChangePct = spotOpen !== 0 ? ((spot - spotOpen) / spotOpen) * 100 : 0;

    // Step 5: Merge calls and puts by strike
    const calls = allSnapshots.filter(s => s.details.contract_type === 'call');
    const puts = allSnapshots.filter(s => s.details.contract_type === 'put');

    const contractMap = new Map();

    // Initialize all strikes from reference contracts
    for (const contract of allContracts) {
      const strike = contract.strike_price;
      if (!contractMap.has(strike)) {
        contractMap.set(strike, {
          strike,
          callBid: 0, callAsk: 0, callLast: 0, callIV: 0, callOI: 0, callVolume: 0,
          callDelta: null, callTheta: null, callGamma: null, callVega: null,
          callVanna: null, callCharm: null,
          putBid: 0, putAsk: 0, putLast: 0, putIV: 0, putOI: 0, putVolume: 0,
          putDelta: null, putTheta: null, putGamma: null, putVega: null,
          putVanna: null, putCharm: null,
          callIlliquid: false,
          putIlliquid: false,
          callBlock: false,
          putBlock: false,
        });
      }
    }

    // Fill in call data
    for (const c of calls) {
      const strike = c.details.strike_price;
      const entry = contractMap.get(strike);
      if (!entry) continue;

      entry.callBid = c.day?.open ?? 0;
      entry.callAsk = c.day?.close ?? 0;
      entry.callLast = c.last_quote?.price ?? 0;
      entry.callIV = c.implied_volatility ?? 0;
      entry.callOI = c.open_interest ?? 0;
      entry.callVolume = c.day?.volume ?? 0;

      // Phase 2 Greeks — REAL values from Polygon or null
      entry.callDelta  = c.greeks?.delta  ?? null;
      entry.callTheta  = c.greeks?.theta  ?? null;
      entry.callGamma  = c.greeks?.gamma  ?? null;
      entry.callVega   = c.greeks?.vega   ?? null;

      // Phase 3 Greeks
      entry.callVanna  = c.greeks?.vanna  ?? null;
      entry.callCharm  = c.greeks?.charm  ?? null;

      // Phase 3 flags
      const spread = entry.callBid > 0 ? (entry.callAsk - entry.callBid) / entry.callBid : 0;
      entry.callIlliquid = spread > 0.5;

      const conditions = c.last_quote?.conditions || [];
      entry.callBlock = conditions.includes('41') || (c.last_quote?.size || 0) > 100;
    }

    // Fill in put data
    for (const p of puts) {
      const strike = p.details.strike_price;
      const entry = contractMap.get(strike);
      if (!entry) continue;

      entry.putBid = p.day?.open ?? 0;
      entry.putAsk = p.day?.close ?? 0;
      entry.putLast = p.last_quote?.price ?? 0;
      entry.putIV = p.implied_volatility ?? 0;
      entry.putOI = p.open_interest ?? 0;
      entry.putVolume = p.day?.volume ?? 0;

      entry.putDelta  = p.greeks?.delta  ?? null;
      entry.putTheta  = p.greeks?.theta  ?? null;
      entry.putGamma  = p.greeks?.gamma  ?? null;
      entry.putVega   = p.greeks?.vega   ?? null;
      entry.putVanna  = p.greeks?.vanna  ?? null;
      entry.putCharm  = p.greeks?.charm  ?? null;

      const spread = entry.putBid > 0 ? (entry.putAsk - entry.putBid) / entry.putBid : 0;
      entry.putIlliquid = spread > 0.5;

      const conditions = p.last_quote?.conditions || [];
      entry.putBlock = conditions.includes('41') || (p.last_quote?.size || 0) > 100;
    }

    let contracts = Array.from(contractMap.values()).sort((a, b) => a.strike - b.strike);
    
    // NEW: Check if market is closed and enrich with stored Greeks if needed
    const marketOpen = isMarketOpen();
    let dataSource = 'polygon-realtime';
    
    if (!marketOpen) {
      console.log('[chain.js] Market closed - fetching stored Greeks for enrichment');
      const snapshots = await fetchGreeksSnapshot(sym, resolvedExpiration);
      if (snapshots.length > 0) {
        contracts = enrichWithStoredGreeks(contracts, snapshots);
        dataSource = 'polygon-last-session';
      }
    }

    // Step 6: Compute Phase 3 metrics
    const totalCallOI = contracts.reduce((sum, c) => sum + c.callOI, 0);
    const totalPutOI = contracts.reduce((sum, c) => sum + c.putOI, 0);
    const totalCallVolume = contracts.reduce((sum, c) => sum + c.callVolume, 0);
    const totalPutVolume = contracts.reduce((sum, c) => sum + c.putVolume, 0);

    // VWIV (volume-weighted implied volatility)
    let callIVSum = 0, callVolSum = 0, putIVSum = 0, putVolSum = 0;
    for (const c of contracts) {
      if (c.callIV > 0 && c.callVolume > 0) {
        callIVSum += c.callIV * c.callVolume;
        callVolSum += c.callVolume;
      }
      if (c.putIV > 0 && c.putVolume > 0) {
        putIVSum += c.putIV * c.putVolume;
        putVolSum += c.putVolume;
      }
    }
    const vwivCall = callVolSum > 0 ? callIVSum / callVolSum : 0;
    const vwivPut = putVolSum > 0 ? putIVSum / putVolSum : 0;

    // OI concentration walls (top 5)
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

    // Block trade counts
    const blockCallCount = contracts.filter(c => c.callBlock).length;
    const blockPutCount = contracts.filter(c => c.putBlock).length;

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
