const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;
const MAX_PAGES = 10;

// Supabase client for Greeks retrieval
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

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

// ─── Market Hours Detection ───────────────────────────────────────────────────

function isMarketOpen() {
  try {
    const now = new Date();
    
    // Get CT time components
    const ctFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    
    const parts = ctFormatter.formatToParts(now);
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    
    // Weekend check
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    
    // Market hours: 8:30 AM - 3:00 PM CT (9:30 AM - 4:00 PM ET)
    const minutes = hour * 60 + minute;
    const marketOpen = 8 * 60 + 30;  // 8:30 AM
    const marketClose = 15 * 60;      // 3:00 PM
    
    return minutes >= marketOpen && minutes < marketClose;
  } catch {
    return true; // Default to market open if detection fails
  }
}

// ─── Greeks Snapshot Retrieval ────────────────────────────────────────────────

async function getStoredGreeks(symbol, expiry) {
  try {
    const { data, error } = await supabase
      .from('greeks_snapshots')
      .select('*')
      .eq('symbol', symbol)
      .eq('expiry', expiry)
      .order('snapshot_time', { ascending: false })
      .limit(500); // reasonable limit for one expiry

    if (error) {
      console.error('[chain.js] Supabase query error:', error);
      return [];
    }

    if (!data || data.length === 0) {
      console.log(`[chain.js] No stored Greeks found for ${symbol} ${expiry}`);
      return [];
    }

    console.log(`[chain.js] ✓ Retrieved ${data.length} stored Greeks for ${symbol} ${expiry}`);
    return data;
  } catch (err) {
    console.error('[chain.js] Failed to retrieve stored Greeks:', err);
    return [];
  }
}

function enrichContractsWithStoredGreeks(contracts, storedGreeks) {
  if (!storedGreeks || storedGreeks.length === 0) return contracts;

  // Build lookup map: strike -> stored Greeks row
  const greeksMap = new Map();
  for (const row of storedGreeks) {
    greeksMap.set(Number(row.strike), row);
  }

  let enrichedCount = 0;

  for (const contract of contracts) {
    const stored = greeksMap.get(contract.strike);
    if (!stored) continue;

    // Enrich with real last-session Greeks
    contract.callDelta = stored.call_delta ?? contract.callDelta;
    contract.callTheta = stored.call_theta ?? contract.callTheta;
    contract.callGamma = stored.call_gamma ?? contract.callGamma;
    contract.callVega  = stored.call_vega  ?? contract.callVega;
    contract.callVanna = stored.call_vanna ?? contract.callVanna;
    contract.callCharm = stored.call_charm ?? contract.callCharm;

    contract.putDelta = stored.put_delta ?? contract.putDelta;
    contract.putTheta = stored.put_theta ?? contract.putTheta;
    contract.putGamma = stored.put_gamma ?? contract.putGamma;
    contract.putVega  = stored.put_vega  ?? contract.putVega;
    contract.putVanna = stored.put_vanna ?? contract.putVanna;
    contract.putCharm = stored.put_charm ?? contract.putCharm;

    // Optionally enrich pricing if current Polygon data is stale
    if (contract.callBid === 0 && stored.call_bid != null) {
      contract.callBid = stored.call_bid;
      contract.callAsk = stored.call_ask ?? contract.callAsk;
      contract.callLast = stored.call_last ?? contract.callLast;
    }
    if (contract.putBid === 0 && stored.put_bid != null) {
      contract.putBid = stored.put_bid;
      contract.putAsk = stored.put_ask ?? contract.putAsk;
      contract.putLast = stored.put_last ?? contract.putLast;
    }

    enrichedCount++;
  }

  console.log(`[chain.js] Enriched ${enrichedCount}/${contracts.length} contracts with stored Greeks`);
  return contracts;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbol, expiration, datesOnly, allExpiries } = req.query;
  const sym = (symbol || '').toUpperCase().trim();

  if (!sym) {
    return res.status(400).json({ error: 'symbol required', usage: 'GET /api/chain?symbol=TSLA&expiration=2026-06-20' });
  }

  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  if (!POLYGON_KEY) {
    console.error('[chain.js] POLYGON_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ─── Mode 1: Return available expiry dates only ────────────────────────────────

  if (datesOnly === 'true') {
    const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const json = await polygonFetch(url);
    if (!json || !json.results || json.results.length === 0) {
      return res.status(200).json({ expiryDates: [] });
    }

    const dates = [...new Set(json.results.map(r => r.expiration_date))].sort();
    return res.status(200).json({ expiryDates: dates });
  }

  // ─── Mode 2: Multi-expiry GEX stack (for Scan dashboard) ──────────────────────

  if (allExpiries === 'true') {
    const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const datesJson = await polygonFetch(datesUrl);

    if (!datesJson || !datesJson.results || datesJson.results.length === 0) {
      return res.status(200).json({ expiryDates: [], stacks: [] });
    }

    const allDates = [...new Set(datesJson.results.map(r => r.expiration_date))].sort();
    const targetDates = allDates.slice(0, 8); // first 8 expiries

    const stacks = [];

    for (const exp of targetDates) {
      const contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expiration_date=${exp}&limit=1000&apiKey=${POLYGON_KEY}`;
      const contractsJson = await polygonFetch(contractsUrl);

      if (!contractsJson || !contractsJson.results || contractsJson.results.length === 0) continue;

      const tickers = contractsJson.results.map(r => r.ticker);
      if (tickers.length === 0) continue;

      const snapshotUrl = `https://api.polygon.io/v3/snapshot/options/${sym}/${encodeURIComponent(tickers.join(','))}?apiKey=${POLYGON_KEY}`;
      const snapshotJson = await polygonFetch(snapshotUrl);

      if (!snapshotJson || !snapshotJson.results || snapshotJson.results.length === 0) continue;

      const calls = snapshotJson.results.filter(r => r.details.contract_type === 'call');
      const puts = snapshotJson.results.filter(r => r.details.contract_type === 'put');

      const strikeMap = new Map();

      for (const c of calls) {
        const k = c.details.strike_price;
        if (!strikeMap.has(k)) strikeMap.set(k, { strike: k, callGamma: 0, putGamma: 0, callOI: 0, putOI: 0 });
        const entry = strikeMap.get(k);
        entry.callGamma = c.greeks?.gamma ?? 0;
        entry.callOI = c.open_interest ?? 0;
      }

      for (const p of puts) {
        const k = p.details.strike_price;
        if (!strikeMap.has(k)) strikeMap.set(k, { strike: k, callGamma: 0, putGamma: 0, callOI: 0, putOI: 0 });
        const entry = strikeMap.get(k);
        entry.putGamma = p.greeks?.gamma ?? 0;
        entry.putOI = p.open_interest ?? 0;
      }

      const contracts = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

      stacks.push({
        expiry: exp,
        contracts,
        totalCallGamma: contracts.reduce((sum, c) => sum + (c.callGamma || 0) * (c.callOI || 0) * 100, 0),
        totalPutGamma: contracts.reduce((sum, c) => sum + (c.putGamma || 0) * (c.putOI || 0) * 100, 0),
      });
    }

    return res.status(200).json({ expiryDates: allDates, stacks });
  }

  // ─── Mode 3: Single expiry — full chain with Phase 3 fields ──────────────────

  if (!expiration) {
    return res.status(400).json({ error: 'expiration required', usage: 'GET /api/chain?symbol=TSLA&expiration=2026-06-20' });
  }

  try {
    // Step 1: Validate and resolve expiration date
    const datesUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&expired=false&limit=1000&apiKey=${POLYGON_KEY}`;
    const datesJson = await polygonFetch(datesUrl);

    if (!datesJson || !datesJson.results || datesJson.results.length === 0) {
      return res.status(200).json({
        contracts: [], symbol: sym, spot: 0, spotChangePct: 0, expiration,
        source: 'polygon-no-data',
      });
    }

    const availableDates = [...new Set(datesJson.results.map(r => r.expiration_date))].sort();

    let resolvedExpiration = expiration;
    if (!availableDates.includes(expiration)) {
      const nearest = availableDates.reduce((prev, curr) =>
        Math.abs(new Date(curr) - new Date(expiration)) < Math.abs(new Date(prev) - new Date(expiration)) ? curr : prev
      );
      resolvedExpiration = nearest;
      console.log(`[chain.js] Auto-slid ${sym} from ${expiration} → ${resolvedExpiration}`);
    }

    // Step 2: Fetch all option tickers for this expiry with pagination
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

    console.log(`[chain.js] ${sym} ${resolvedExpiration}: fetched ${allContracts.length} contracts in ${pageCount} page(s)`);

    // Step 3: Fetch snapshots for all tickers (batched)
    const tickers = allContracts.map(r => r.ticker);
    const BATCH_SIZE = 250;
    let allSnapshots = [];

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const snapshotUrl = `https://api.polygon.io/v3/snapshot/options/${sym}/${encodeURIComponent(batch.join(','))}?apiKey=${POLYGON_KEY}`;
      const snapshotJson = await polygonFetch(snapshotUrl);

      if (snapshotJson && snapshotJson.results) {
        allSnapshots = allSnapshots.concat(snapshotJson.results);
      }

      if (i + BATCH_SIZE < tickers.length) {
        await sleep(100); // gentle rate limit between batches
      }
    }

    console.log(`[chain.js] ${sym} ${resolvedExpiration}: received ${allSnapshots.length} snapshots`);

    // Step 4: Get spot price
    const quoteUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?apiKey=${POLYGON_KEY}`;
    const quoteJson = await polygonFetch(quoteUrl);
    const spot = quoteJson?.results?.[0]?.c ?? 0;
    const spotVwap = quoteJson?.results?.[0]?.vw ?? spot;
    const prevClose = quoteJson?.results?.[0]?.c ?? spot;
    const spotChangePct = prevClose !== 0 ? ((spot - prevClose) / prevClose) * 100 : 0;

    // Step 5: Merge calls and puts by strike
    const calls = allSnapshots.filter(s => s.details.contract_type === 'call');
    const puts = allSnapshots.filter(s => s.details.contract_type === 'put');

    const contractMap = new Map();

    // Initialize all strikes from contract list
    for (const contract of allContracts) {
      const strike = contract.strike_price;
      if (!contractMap.has(strike)) {
        contractMap.set(strike, {
          strike,
          // Bid/Ask/Last
          callBid: 0, callAsk: 0, callIV: 0, callOI: 0, callVolume: 0,
          callLast: 0, callDayVol: 0, callPrevDayVol: 0, callVolumeRatio: null,
          callIlliquid: false, callBlock: false,
          // Greeks (Phase 2)
          callDelta: null, callTheta: null, callGamma: null, callVega: null,
          // Phase 3 Greeks
          callVanna: null, callCharm: null,
          // Puts
          putBid: 0, putAsk: 0, putIV: 0, putOI: 0, putVolume: 0,
          putLast: 0, putDayVol: 0, putPrevDayVol: 0, putVolumeRatio: null,
          putIlliquid: false, putBlock: false,
          putDelta: null, putTheta: null, putGamma: null, putVega: null,
          putVanna: null, putCharm: null,
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
      entry.callLast = c.last_quote?.midpoint ?? 0;
      entry.callIV = c.implied_volatility ?? 0;
      entry.callOI = c.open_interest ?? 0;
      entry.callVolume = c.day?.volume ?? 0;
      entry.callDayVol = c.day?.volume ?? 0;
      entry.callPrevDayVol = c.day?.previous_close ?? 0;
      entry.callVolumeRatio = entry.callPrevDayVol !== 0 ? entry.callDayVol / entry.callPrevDayVol : null;

      // Phase 2 Greeks — REAL values from Polygon or null
      entry.callDelta  = c.greeks?.delta  ?? null;
      entry.callTheta  = c.greeks?.theta  ?? null;
      entry.callGamma  = c.greeks?.gamma  ?? null;  // REAL gamma or null — NO FAKE ESTIMATION
      entry.callVega   = c.greeks?.vega   ?? null;

      // Phase 3 Greeks
      entry.callVanna  = c.greeks?.vanna  ?? null;
      entry.callCharm  = c.greeks?.charm  ?? null;

      // Illiquid flag
      const mid = (entry.callBid + entry.callAsk) / 2;
      const spread = entry.callAsk - entry.callBid;
      entry.callIlliquid = mid !== 0 && (spread / mid) > 0.5;

      // Block trade flag (simple heuristic: large size or condition code 41)
      const conditions = c.last_trade?.conditions ?? [];
      entry.callBlock = conditions.includes('41') || (c.last_trade?.size ?? 0) > 100;
    }

    // Fill in put data
    for (const p of puts) {
      const strike = p.details.strike_price;
      const entry = contractMap.get(strike);
      if (!entry) continue;

      entry.putBid = p.day?.open ?? 0;
      entry.putAsk = p.day?.close ?? 0;
      entry.putLast = p.last_quote?.midpoint ?? 0;
      entry.putIV = p.implied_volatility ?? 0;
      entry.putOI = p.open_interest ?? 0;
      entry.putVolume = p.day?.volume ?? 0;
      entry.putDayVol = p.day?.volume ?? 0;
      entry.putPrevDayVol = p.day?.previous_close ?? 0;
      entry.putVolumeRatio = entry.putPrevDayVol !== 0 ? entry.putDayVol / entry.putPrevDayVol : null;

      // Phase 2 Greeks
      entry.putDelta  = p.greeks?.delta  ?? null;
      entry.putTheta  = p.greeks?.theta  ?? null;
      entry.putGamma  = p.greeks?.gamma  ?? null;
      entry.putVega   = p.greeks?.vega   ?? null;

      // Phase 3 Greeks
      entry.putVanna  = p.greeks?.vanna  ?? null;
      entry.putCharm  = p.greeks?.charm  ?? null;

      // Illiquid flag
      const mid = (entry.putBid + entry.putAsk) / 2;
      const spread = entry.putAsk - entry.putBid;
      entry.putIlliquid = mid !== 0 && (spread / mid) > 0.5;

      // Block trade flag
      const conditions = p.last_trade?.conditions ?? [];
      entry.putBlock = conditions.includes('41') || (p.last_trade?.size ?? 0) > 100;
    }

    let contracts = Array.from(contractMap.values()).sort((a, b) => a.strike - b.strike);

    // ─── NEW: Phase 3.5 — Enrich with stored Greeks if market is closed ───────────

    const marketOpen = isMarketOpen();
    let dataSource = 'polygon-realtime';

    if (!marketOpen) {
      console.log(`[chain.js] Market closed — checking for stored Greeks for ${sym} ${resolvedExpiration}`);
      const storedGreeks = await getStoredGreeks(sym, resolvedExpiration);
      if (storedGreeks.length > 0) {
        contracts = enrichContractsWithStoredGreeks(contracts, storedGreeks);
        dataSource = 'polygon-last-session';
      } else {
        console.log(`[chain.js] No stored Greeks found — Greeks will be null`);
        dataSource = 'polygon-stale';
      }
    }

    // Step 6: Compute chain-level metrics (Phase 3)

    // Volume-weighted IV (VWIV)
    let callVolSum = 0, callIVxVol = 0;
    let putVolSum = 0, putIVxVol = 0;

    for (const c of contracts) {
      if (c.callVolume > 0 && c.callIV > 0) {
        callVolSum += c.callVolume;
        callIVxVol += c.callIV * c.callVolume;
      }
      if (c.putVolume > 0 && c.putIV > 0) {
        putVolSum += c.putVolume;
        putIVxVol += c.putIV * c.putVolume;
      }
    }

    const vwivCall = callVolSum > 0 ? callIVxVol / callVolSum : 0;
    const vwivPut = putVolSum > 0 ? putIVxVol / putVolSum : 0;

    // OI walls (top 5 call/put OI strikes)
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
