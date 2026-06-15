module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();

  // ── Intraday candles (last 15 × 5-min bars) ───────────────────────────────
  if (type === 'candles') {
    const polygonKey = process.env.POLYGON_API_KEY;
    if (!polygonKey) return res.status(500).json({ error: 'No Polygon key' });
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const toStr = now.toISOString();
      const fromStr = from.toISOString();
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/5/minute/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=20&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!candleRes.ok) throw new Error(`Polygon candles status ${candleRes.status}`);
      const data = await candleRes.json();
      const bars = (data?.results ?? []).slice(-15);
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Candles fetch failed' });
    }
  }

  // ── Aggregate (20-day ADV) ─────────────────────────────────────────────────
  if (type === 'agg') {
    const polygonKey = process.env.POLYGON_API_KEY;
    if (!polygonKey) return res.status(500).json({ error: 'No Polygon key' });
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 35);
      const toStr = to.toISOString().split('T')[0];
      const fromStr = from.toISOString().split('T')[0];
      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=30&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!aggRes.ok) throw new Error(`Polygon agg status ${aggRes.status}`);
      const data = await aggRes.json();
      const bars = data?.results ?? [];
      if (bars.length === 0) return res.status(200).json({ symbol: sym, adv: null });
      const recent = bars.slice(-20);
      const adv = Math.round(recent.reduce((s, b) => s + (b.v ?? 0), 0) / recent.length);
      return res.status(200).json({ symbol: sym, adv, bars: recent.length, source: 'polygon' });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'ADV fetch failed' });
    }
  }

  // ── Options Greeks snapshot (ATM call + put for nearest expiry) ── NEW ─────
  if (type === 'options') {
    const polygonKey = process.env.POLYGON_API_KEY;
    if (!polygonKey) return res.status(500).json({ error: 'No Polygon key' });
    try {
      // Step 1: Get current price to find ATM strike
      const quoteRes = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!quoteRes.ok) throw new Error(`Quote fetch failed ${quoteRes.status}`);
      const quoteData = await quoteRes.json();
      const ticker = quoteData?.ticker;
      const currentPrice = ticker?.day?.c || ticker?.lastTrade?.p || ticker?.prevDay?.c;
      if (!currentPrice) throw new Error('Could not get current price for ATM calc');

      // Step 2: Fetch options contracts near ATM for nearest expiry
      // Polygon v3 options contracts endpoint
      const callRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?limit=250&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!callRes.ok) throw new Error(`Options chain fetch failed ${callRes.status}`);
      const chainData = await callRes.json();
      const contracts = chainData?.results ?? [];

      if (contracts.length === 0) {
        return res.status(200).json({ symbol: sym, error: 'No options data', source: 'polygon' });
      }

      // Step 3: Find nearest expiry
      const expiries = [...new Set(contracts.map(c => c.details?.expiration_date).filter(Boolean))].sort();
      const nearestExpiry = expiries[0];

      // Step 4: Filter to nearest expiry only
      const nearExpiry = contracts.filter(c => c.details?.expiration_date === nearestExpiry);

      // Step 5: Find ATM call and put (closest strike to current price)
      const calls = nearExpiry.filter(c => c.details?.contract_type === 'call');
      const puts = nearExpiry.filter(c => c.details?.contract_type === 'put');

      const findATM = (contracts, price) => {
        if (contracts.length === 0) return null;
        return contracts.reduce((best, c) => {
          const strike = c.details?.strike_price;
          if (!strike) return best;
          if (!best) return c;
          return Math.abs(strike - price) < Math.abs((best.details?.strike_price ?? Infinity) - price) ? c : best;
        }, null);
      };

      const atmCall = findATM(calls, currentPrice);
      const atmPut = findATM(puts, currentPrice);

      const extractContract = (c) => {
        if (!c) return null;
        const g = c.greeks ?? {};
        const d = c.day ?? {};
        const q = c.last_quote ?? {};
        return {
          strike: c.details?.strike_price ?? null,
          expiry: c.details?.expiration_date ?? null,
          bid: q.bid ?? null,
          ask: q.ask ?? null,
          mid: (q.bid != null && q.ask != null) ? +((q.bid + q.ask) / 2).toFixed(2) : null,
          iv: c.implied_volatility != null ? +(c.implied_volatility * 100).toFixed(1) : null,
          delta: g.delta != null ? +g.delta.toFixed(3) : null,
          gamma: g.gamma != null ? +g.gamma.toFixed(4) : null,
          theta: g.theta != null ? +g.theta.toFixed(4) : null,
          vega: g.vega != null ? +g.vega.toFixed(4) : null,
          oi: c.open_interest ?? null,
          volume: d.volume ?? null,
        };
      };

      // P/C ratio from full chain
      const totalCallOI = calls.reduce((s, c) => s + (c.open_interest ?? 0), 0);
      const totalPutOI = puts.reduce((s, c) => s + (c.open_interest ?? 0), 0);
      const pcRatio = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(2) : null;

      // Implied move estimate (1σ = ATM straddle price / underlying price)
      const atmC = extractContract(atmCall);
      const atmP = extractContract(atmPut);
      const straddlePrice = (atmC?.mid ?? 0) + (atmP?.mid ?? 0);
      const impliedMovePct = straddlePrice > 0 && currentPrice > 0
        ? +((straddlePrice / currentPrice) * 100).toFixed(2)
        : null;

      return res.status(200).json({
        symbol: sym,
        currentPrice,
        nearestExpiry,
        atmCall: atmC,
        atmPut: atmP,
        pcRatio,
        impliedMovePct,
        source: 'polygon',
      });

    } catch (e) {
      return res.status(500).json({ error: e.message || 'Options snapshot failed' });
    }
  }

  // ── Try Polygon first (default quote) ─────────────────────────────────────
  const polygonKey = process.env.POLYGON_API_KEY;
  if (polygonKey) {
    try {
      const polyRes = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (polyRes.ok) {
        const data = await polyRes.json();
        const t = data?.ticker;
        if (t) {
          const price = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
          const prevClose = t.prevDay?.c || price;
          const change = price - prevClose;
          const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
          return res.status(200).json({
            symbol: sym,
            price,
            change,
            changePct,
            high: t.day?.h ?? null,
            low: t.day?.l ?? null,
            open: t.day?.o ?? null,
            prevClose,
            volume: t.day?.v ?? 0,
            name: t.name ?? sym,
            week52High: t.day?.h ?? null,
            week52Low: t.day?.l ?? null,
            source: 'polygon',
          });
        }
      }
    } catch (e) {
      console.warn('Polygon quote failed, falling back to Yahoo:', e.message);
    }
  }

  // ── Yahoo Finance fallback ─────────────────────────────────────────────────
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
    const yahooRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Helios/1.0)',
        Accept: 'application/json',
      },
    });
    if (!yahooRes.ok) throw new Error(`Yahoo status ${yahooRes.status}`);
    const json = await yahooRes.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta in Yahoo response');

    const price = meta.regularMarketPrice ?? meta.previousClose ?? 0;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol: sym,
      price,
      change,
      changePct,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      open: meta.regularMarketOpen ?? null,
      prevClose,
      volume: meta.regularMarketVolume ?? 0,
      name: meta.shortName ?? meta.longName ?? sym,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low: meta.fiftyTwoWeekLow ?? null,
      source: 'yahoo',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Quote fetch failed' });
  }
};
