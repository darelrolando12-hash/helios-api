module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  // ── Shared spot price helper — same pattern as chain.js (proven to work) ──────
  // Uses ONLY endpoints available on Options Advanced plan.
  async function fetchSpot(ticker) {
    try {
      // Normalize index symbols for Polygon (^VIX → I:VIX)
      const polygonTicker = ticker.startsWith('^')
        ? ticker.replace('^', 'I:')
        : ticker === 'VIX' ? 'I:VIX'
        : ticker === 'SPX' ? 'I:SPX'
        : ticker;

      // 1. Prev-day aggregate — always works on Options Advanced, 24/7
      const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonTicker)}/prev?adjusted=true&apiKey=${polygonKey}`;
      const prevR = await fetch(prevUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
      let prevClose = 0;
      let prevVwap  = 0;
      let prevHigh  = 0;
      let prevLow   = 0;
      let prevOpen  = 0;
      let prevVol   = 0;
      if (prevR.ok) {
        const d = await prevR.json();
        const bar = d?.results?.[0];
        if (bar) {
          prevClose = bar.c ?? 0;
          prevVwap  = bar.vw ?? 0;
          prevHigh  = bar.h ?? 0;
          prevLow   = bar.l ?? 0;
          prevOpen  = bar.o ?? 0;
          prevVol   = bar.v ?? 0;
        }
      }

      // 2. Live last trade — works during market hours
      let livePrice = 0;
      let liveTime  = null;
      let liveSize  = null;
      try {
        const lastUrl = `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(polygonTicker)}?apiKey=${polygonKey}`;
        const lastR = await fetch(lastUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
        if (lastR.ok) {
          const d = await lastR.json();
          livePrice = d?.results?.p ?? d?.last?.price ?? 0;
          liveTime  = d?.results?.t ?? d?.last?.timestamp ?? null;
          liveSize  = d?.results?.s ?? d?.last?.size ?? null;
        }
      } catch { /* live price unavailable — use prevClose below */ }

      const price = livePrice > 0 ? livePrice : prevClose;
      return { price, prevClose, vwap: prevVwap, high: prevHigh, low: prevLow, open: prevOpen, volume: prevVol, liveTime, liveSize };
    } catch {
      return { price: 0, prevClose: 0, vwap: 0, high: 0, low: 0, open: 0, volume: 0, liveTime: null, liveSize: null };
    }
  }

  // ── Yahoo Finance fallback (15-min delayed — only when Polygon fails entirely) ──
  async function fetchYahooFallback() {
    try {
      const yahooRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)', Accept: 'application/json' } }
      );
      if (!yahooRes.ok) throw new Error(`Yahoo status ${yahooRes.status}`);
      const json = await yahooRes.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error('No meta in Yahoo response');

      const price     = meta.regularMarketPrice ?? meta.previousClose ?? 0;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
      const change    = price - prevClose;
      const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      const rawHigh   = meta.regularMarketDayHigh ?? null;
      const rawLow    = meta.regularMarketDayLow  ?? null;
      const rawOpen   = meta.regularMarketOpen    ?? null;
      const estOpen   = rawOpen ?? prevClose;
      const estHigh   = rawHigh != null ? Math.max(rawHigh, price, estOpen) : Math.max(price, estOpen);
      const estLow    = rawLow  != null ? Math.min(rawLow,  price, estOpen) : Math.min(price, estOpen);

      return res.status(200).json({
        symbol: sym, price, change, changePct,
        high: estHigh, low: estLow, open: estOpen, prevClose,
        volume: meta.regularMarketVolume ?? 0,
        name: meta.shortName ?? meta.longName ?? sym,
        week52High: meta.fiftyTwoWeekHigh ?? null,
        week52Low:  meta.fiftyTwoWeekLow  ?? null,
        vwap: null, bid: null, ask: null,
        source: 'yahoo-delayed',
        partialCandle: !rawHigh || !rawLow || !rawOpen,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Quote fetch failed' });
    }
  }

  // ── Yahoo Finance contract existence validator ────────────────────────────────
  if (type === 'validate_contract') {
    const { expiry, strike, optionType } = req.query;
    if (!expiry || !strike || !optionType) {
      return res.status(400).json({ error: 'expiry, strike, optionType required' });
    }
    try {
      const expiryDate  = new Date(expiry + 'T12:00:00Z');
      const expiryUnix  = Math.floor(expiryDate.getTime() / 1000);
      const yahooChain  = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?date=${expiryUnix}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)', Accept: 'application/json' } }
      );
      if (!yahooChain.ok) {
        return res.status(200).json({ exists: false, source: 'yahoo-delayed' });
      }
      const chainData = await yahooChain.json();
      const chain = chainData?.optionChain?.result?.[0];
      if (!chain) {
        return res.status(200).json({ exists: false, source: 'yahoo-delayed' });
      }
      const targetStrike  = parseFloat(strike);
      const contracts     = optionType === 'call'
        ? (chain.options?.[0]?.calls ?? [])
        : (chain.options?.[0]?.puts  ?? []);
      const match = contracts.find(c => Math.abs(c.strike - targetStrike) < 0.01);
      return res.status(200).json({
        exists: !!match,
        strike: match?.strike ?? targetStrike,
        expiry,
        optionType,
        bid:              match?.bid              ?? null,
        ask:              match?.ask              ?? null,
        lastPrice:        match?.lastPrice        ?? null,
        openInterest:     match?.openInterest     ?? null,
        impliedVolatility: match?.impliedVolatility ?? null,
        source: 'yahoo-delayed',
      });
    } catch (err) {
      return res.status(200).json({ exists: null, error: err.message, source: 'yahoo-delayed' });
    }
  }

  // ── Intraday candles (last 60 × 1-min bars) ───────────────────────────────────
  if (type === 'candles') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1000);
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${from.toISOString()}/${now.toISOString()}?adjusted=true&sort=asc&limit=60&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!candleRes.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${candleRes.status}` });
      const data = await candleRes.json();
      const bars = (data?.results ?? []).map(b => ({
        time: new Date(b.t).toISOString(),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon-realtime', resolution: '1min' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles failed' });
    }
  }

  // ── 20-day ADV (average daily volume) OR historical OHLCV range ──────────────
  if (type === 'agg') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: 'No Polygon key' });
    try {
      const customFrom = req.query.from;
      const customTo   = req.query.to;
      const timespan   = req.query.timespan  || 'day';
      const multiplier = req.query.multiplier || '1';
      const isBacktest = !!(customFrom && customTo);
      const toDate     = customTo   ?? new Date().toISOString().split('T')[0];
      const fromDate   = customFrom ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const limit      = isBacktest ? 1000 : 30;

      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=${limit}&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!aggRes.ok) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: `Polygon ${aggRes.status}` });
      const data = await aggRes.json();
      const bars = data?.results ?? [];
      if (!bars.length) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, bars: 0, results: [] });

      if (isBacktest) {
        return res.status(200).json({ symbol: sym, results: bars, count: bars.length, source: 'polygon' });
      }
      const volumes        = bars.map(b => b.v || 0);
      const avgDailyVolume = Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length);
      return res.status(200).json({ symbol: sym, avgDailyVolume, bars: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, avgDailyVolume: 0, results: [], error: e.message || 'ADV failed' });
    }
  }

  // ── ATM Options Greeks (IV, delta, gamma, theta, P/C ratio) ──────────────────
  // Spot price now uses fetchSpot() — NO broken stocks snapshot endpoint
  if (type === 'options') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const { price: spot } = await fetchSpot(sym);
      if (!spot) return res.status(200).json({ symbol: sym, error: 'No spot price' });

      const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const optRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&limit=50&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!optRes.ok) return res.status(200).json({ symbol: sym, spot, error: `Options snapshot ${optRes.status}` });
      const optData = await optRes.json();
      const results = optData?.results ?? [];

      let atmCall = null, atmPut = null;
      let minCallDist = Infinity, minPutDist = Infinity;
      let totalCallOI = 0, totalPutOI = 0;
      let totalCallVol = 0, totalPutVol = 0;

      for (const r of results) {
        const strike = r.details?.strike_price ?? 0;
        const type_  = r.details?.contract_type ?? '';
        const oi     = r.open_interest ?? 0;
        const vol    = r.day?.volume ?? 0;
        if (type_ === 'call') { totalCallOI += oi; totalCallVol += vol; }
        if (type_ === 'put')  { totalPutOI  += oi; totalPutVol  += vol; }
        const dist = Math.abs(strike - spot);
        if (type_ === 'call' && dist < minCallDist) { minCallDist = dist; atmCall = r; }
        if (type_ === 'put'  && dist < minPutDist)  { minPutDist = dist; atmPut  = r; }
      }

      const callIV    = atmCall?.greeks?.implied_volatility ? atmCall.greeks.implied_volatility * 100 : null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const putIV     = atmPut?.greeks?.implied_volatility  ? atmPut.greeks.implied_volatility * 100  : null;
      const putDelta  = atmPut?.greeks?.delta  ?? null;
      const pcRatio   = totalCallOI > 0 ? totalPutOI / totalCallOI : null;
      const callMid   = atmCall ? ((atmCall.last_quote?.ask ?? 0) + (atmCall.last_quote?.bid ?? 0)) / 2 : 0;
      const putMid    = atmPut  ? ((atmPut.last_quote?.ask  ?? 0) + (atmPut.last_quote?.bid  ?? 0)) / 2  : 0;
      const impliedMove = spot > 0 && (callMid + putMid) > 0
        ? ((callMid + putMid) / spot * 100).toFixed(2)
        : null;

      return res.status(200).json({
        symbol: sym, spot, callIV, callDelta, callGamma, callTheta,
        putIV, putDelta, pcRatio, totalCallOI, totalPutOI,
        totalCallVol, totalPutVol, impliedMove,
        source: 'polygon-realtime',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'Options Greeks failed' });
    }
  }

  // ── Historical Volatility (5yr daily bars → HV computation) ─────────────────
  if (type === 'hv') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=1500&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!hvRes.ok) {
        return res.status(200).json({ symbol: sym, error: `Polygon HV ${hvRes.status}` });
      }
      const hvData = await hvRes.json();
      const bars   = hvData?.results ?? [];
      if (bars.length < 22) {
        return res.status(200).json({ symbol: sym, error: 'Insufficient history for HV', bars: bars.length });
      }

      const closes = bars.map(b => b.c);
      const logReturns = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i - 1] > 0) {
          logReturns.push(Math.log(closes[i] / closes[i - 1]));
        }
      }

      function computeHV(returns, window) {
        if (returns.length < window) return null;
        const slice    = returns.slice(-window);
        const mean     = slice.reduce((a, b) => a + b, 0) / window;
        const variance = slice.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (window - 1);
        return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
      }

      const hv10  = computeHV(logReturns, 10);
      const hv20  = computeHV(logReturns, 20);
      const hv60  = computeHV(logReturns, 60);
      const hv252 = computeHV(logReturns, 252);

      // 52-week high/low + price percentile
      const last252Closes  = closes.slice(-252);
      const high52w        = Math.max(...last252Closes);
      const low52w         = Math.min(...last252Closes);
      const currentClose   = closes[closes.length - 1];
      const pricePercentile = high52w > low52w
        ? Math.round(((currentClose - low52w) / (high52w - low52w)) * 100)
        : 50;

      // IV/HV ratio (optional — needs live ATM IV)
      let ivHvRatio        = null;
      let expensiveOptions = false;
      let cheapOptions     = false;
      try {
        const { price: spot } = await fetchSpot(sym);
        if (spot > 0) {
          const today   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
          const optSnap = await fetch(
            `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&limit=20&apiKey=${polygonKey}`,
            { headers: { 'User-Agent': 'Helios/3.0' } }
          );
          if (optSnap.ok) {
            const optData = await optSnap.json();
            const results = optData?.results ?? [];
            let atmCall = null, minDist = Infinity;
            for (const r of results) {
              if (r.details?.contract_type !== 'call') continue;
              const dist = Math.abs((r.details?.strike_price ?? 0) - spot);
              if (dist < minDist) { minDist = dist; atmCall = r; }
            }
            const currentIV = atmCall?.greeks?.implied_volatility
              ? atmCall.greeks.implied_volatility * 100
              : null;
            if (currentIV && hv20) {
              ivHvRatio        = parseFloat((currentIV / hv20).toFixed(2));
              expensiveOptions = ivHvRatio > 1.3;
              cheapOptions     = ivHvRatio < 0.7;
            }
          }
        }
      } catch { /* IV ratio is optional */ }

      const priceHistory = bars.slice(-252).map(b => ({ t: b.t, c: b.c, v: b.v }));

      return res.status(200).json({
        symbol: sym,
        hv10, hv20, hv60, hv252,
        ivHvRatio, expensiveOptions, cheapOptions,
        high52w, low52w, currentClose, pricePercentile,
        totalBars: bars.length,
        priceHistory,
        source: 'polygon-5yr',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'HV computation failed' });
    }
  }

  // ── Main quote — Polygon primary, Yahoo fallback ──────────────────────────────
  // Uses fetchSpot() — NO broken stocks snapshot endpoint
  if (!polygonKey) {
    return fetchYahooFallback();
  }

  try {
    const spot = await fetchSpot(sym);

    if (!spot.price) {
      return fetchYahooFallback();
    }

    const price     = spot.price;
    const prevClose = spot.prevClose || price;
    const change    = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol:   sym,
      price,
      change,
      changePct,
      high:     spot.high  || price,
      low:      spot.low   || price,
      open:     spot.open  || prevClose,
      prevClose,
      volume:   spot.volume || 0,
      vwap:     spot.vwap  || null,
      bid:      null,
      ask:      null,
      lastTradeSize: spot.liveSize,
      lastTradeTime: spot.liveTime,
      source: spot.price === spot.prevClose ? 'polygon-prev-close' : 'polygon-realtime',
      partialCandle: false,
    });
  } catch (err) {
    return fetchYahooFallback();
  }
};
