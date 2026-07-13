const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const POLYGON_KEY = process.env.POLYGON_API_KEY;

// ─── Market hours check (8:30–15:00 CT) ──────────────────────────────────────

function isMarketHours() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const total = ct.getHours() * 60 + ct.getMinutes();
  return total >= 8 * 60 + 30 && total <= 15 * 60;
}

// ── DB helper — read prev-day data from daily_market_data ────────────────────
// Eliminates /v2/aggs/prev calls when DB has fresh data.
// Same logic as quote.js and chain.js readDBDailyData() — permanent rate-limit fix.

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
      console.warn(`[ghost-resolve.js] DB daily_market_data stale for ${symbol} (${row.computed_date}) — falling back to Polygon`);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

// ─── Fetch live price ─────────────────────────────────────────────────────────
// RATE LIMIT FIX: DB-first for prev-day close, same as quote.js and chain.js.
//   BEFORE: /v2/aggs/prev on every ghost resolution = ~10–20 calls every 5 min
//   AFTER:  DB-first, Polygon only on DB miss = ~0 calls after daily cron runs

async function getLivePrice(ticker) {
  // ── Step 1: Read prev-day close from DB
  let prevClose = 0;
  let prevFromDB = false;

  const dbRow = await readDBDailyData(ticker);
  if (dbRow && dbRow.prev_close) {
    prevClose  = dbRow.prev_close ?? 0;
    prevFromDB = true;
    console.log(`[ghost-resolve.js] getLivePrice ${ticker}: prev-day from DB (${dbRow.computed_date}), prevClose=${prevClose}`);
  }

  // ── Step 2: If DB miss, fall back to /v2/aggs/prev
  if (POLYGON_KEY && !prevFromDB) {
    try {
      let livePrice = 0;
      let liveVolume = 0;

      // Try /v2/last/stocks first (market hours only)
      const lastUrl = `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(ticker)}?apiKey=${POLYGON_KEY}`;
      const lastRes = await fetch(lastUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (lastRes.ok) {
        const lastData = await lastRes.json();
        livePrice = lastData?.results?.p ?? lastData?.last?.price ?? 0;
        if (livePrice > 0) {
          console.log(`[ghost-resolve.js] getLivePrice ${ticker}: live from /v2/last/stocks (DB miss), price=${livePrice}`);
          return livePrice; // Live price found, skip /prev
        }
      }

      // Fall back to /v2/aggs/prev for prev close
      const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`;
      const prevRes = await fetch(prevUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (prevRes.ok) {
        const prevData = await prevRes.json();
        const bar = prevData?.results?.[0];
        if (bar) {
          prevClose = bar.c ?? 0;
          console.log(`[ghost-resolve.js] getLivePrice ${ticker}: prev-day from Polygon (DB miss), prevClose=${prevClose}`);
          return prevClose;
        }
      }
    } catch (err) {
      console.warn(`[ghost-resolve.js] getLivePrice ${ticker}: Polygon failed — ${err.message}`);
    }
  }

  // ── Step 3: Yahoo fallback
  try {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
    const yahooRes = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)' },
    });
    if (yahooRes.ok) {
      const yahooData = await yahooRes.json();
      const meta = yahooData?.chart?.result?.[0]?.meta;
      if (meta) {
        const yahooPrice = meta.regularMarketPrice ?? meta.previousClose ?? 0;
        console.log(`[ghost-resolve.js] getLivePrice ${ticker}: Yahoo fallback, price=${yahooPrice}`);
        return yahooPrice;
      }
    }
  } catch (yErr) {
    console.warn(`[ghost-resolve.js] getLivePrice ${ticker}: Yahoo failed — ${yErr.message}`);
  }

  // Final fallback: DB prev close or 0
  console.warn(`[ghost-resolve.js] getLivePrice ${ticker}: all sources failed, using prevClose=${prevClose}`);
  return prevClose;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function sbFetch(table, filters = {}) {
  const params = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const r = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`sbFetch ${table} failed: ${r.status}`);
  return r.json();
}

async function sbPost(table, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${table} failed: ${r.status}`);
  return true;
}

async function sbUpdate(table, filters, updates) {
  const params = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(updates),
  });
  if (!r.ok) throw new Error(`sbUpdate ${table} failed: ${r.status}`);
  return true;
}

async function sbDelete(table, filters) {
  const params = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`sbDelete ${table} failed: ${r.status}`);
  return true;
}

// ─── Mistake classifier ───────────────────────────────────────────────────────

function getMistakeType(call, movePct) {
  const expected = call.direction;
  const actual = movePct > 0 ? 'BULLISH' : 'BEARISH';
  if (expected === actual) return 'early_exit';
  return Math.abs(movePct) < 0.5 ? 'flat_chop' : 'wrong_direction';
}

function buildLearnedNote(call, mistake) {
  const base = {
    early_exit: 'Held thesis but exited before move completed',
    flat_chop: 'Market went nowhere — avoid low-volume or consolidation setups',
    wrong_direction: 'Directional thesis was wrong — recheck bias/momentum signals',
  };
  return base[mistake] ?? 'Review setup and signal strength';
}

// ─── Session snapshot updater ─────────────────────────────────────────────────

async function updateSnapshot(source, outcome, conviction, movePct, confidenceVsReality) {
  try {
    const existing = await sbFetch('ghost_session_digest', { source });
    if (existing.length === 0) {
      await sbPost('ghost_session_digest', {
        source,
        total_calls: 1,
        win: outcome === 'win' ? 1 : 0,
        loss: outcome === 'loss' ? 1 : 0,
        avg_conviction: conviction ?? 0,
        avg_move_pct: movePct,
        confidence_vs_reality: confidenceVsReality,
        last_updated: new Date().toISOString(),
      });
    } else {
      const snap = existing[0];
      const newTotal = snap.total_calls + 1;
      const newWin = snap.win + (outcome === 'win' ? 1 : 0);
      const newLoss = snap.loss + (outcome === 'loss' ? 1 : 0);
      const newAvgConv = ((snap.avg_conviction * snap.total_calls) + (conviction ?? 0)) / newTotal;
      const newAvgMove = ((snap.avg_move_pct * snap.total_calls) + movePct) / newTotal;
      const newConfVsReal = ((snap.confidence_vs_reality * snap.total_calls) + confidenceVsReality) / newTotal;
      await sbUpdate('ghost_session_digest', { source }, {
        total_calls: newTotal,
        win: newWin,
        loss: newLoss,
        avg_conviction: parseFloat(newAvgConv.toFixed(2)),
        avg_move_pct: parseFloat(newAvgMove.toFixed(2)),
        confidence_vs_reality: parseFloat(newConfVsReal.toFixed(2)),
        last_updated: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn('[ghost-resolve] updateSnapshot error:', err.message);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret = req.query.secret ?? req.headers['x-cron-secret'];
  if (!isVercelCron && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const startTime = Date.now();
  let resolved = 0;
  let skipped = 0;
  let deadLettered = 0;
  const log = [];

  try {
    // Fetch all pending calls
    const calls = await sbFetch('ghost_calls');
    const pending = calls.filter(c => c.status === 'pending');
    console.log(`[ghost-resolve] Found ${pending.length} pending calls`);

    for (const call of pending) {
      try {
        // Guard 1: Dead letter queue
        const attempts = call.resolve_attempts ?? 0;
        if (attempts >= 3) {
          await sbUpdate('ghost_calls', { id: call.id }, { status: 'dead_letter' });
          deadLettered++;
          log.push(`DEAD ${call.ticker} (3 failed attempts)`);
          continue;
        }

        // Increment resolve attempts
        await sbUpdate('ghost_calls', { id: call.id }, { resolve_attempts: attempts + 1 });

        // Guard 3: Minimum hold time (15 min)
        const age = Date.now() - new Date(call.logged_at).getTime();
        if (age < 15 * 60 * 1000) {
          skipped++;
          continue;
        }

        // Guard 4: Market hours only
        if (!isMarketHours()) {
          skipped++;
          continue;
        }

        // Fetch live price
        const currentPrice = await getLivePrice(call.ticker);
        if (!currentPrice || currentPrice === 0) {
          skipped++;
          log.push(`SKIP ${call.ticker} (no price)`);
          continue;
        }

        const entryPrice = call.entry_price ?? 0;
        if (entryPrice === 0) {
          skipped++;
          log.push(`SKIP ${call.ticker} (no entry price)`);
          continue;
        }

        // Guard 2: Price confidence (skip if price delta > 5% within 2hr window)
        if (age < 2 * 60 * 60 * 1000) {
          const priceDelta = Math.abs((currentPrice - entryPrice) / entryPrice);
          if (priceDelta > 0.05) {
            skipped++;
            log.push(`SKIP ${call.ticker} (price jump ${(priceDelta * 100).toFixed(1)}%)`);
            continue;
          }
        }

        // Compute move
        const movePct = ((currentPrice - entryPrice) / entryPrice) * 100;
        const absMov = Math.abs(movePct);
        const expected = call.direction === 'BULLISH' ? 1 : -1;
        const actual = movePct > 0 ? 1 : -1;
        const outcome = (expected === actual && absMov >= 0.3) ? 'win' : 'loss';

        // Confidence vs reality — how well conviction matched outcome
        const convictionScore = (call.conviction ?? 5) / 10; // 0–1
        const outcomeScore = outcome === 'win' ? 1 : 0;
        const confidenceVsReality = Math.abs(convictionScore - outcomeScore);

        // Guard 6: Confidence decay
        const ageInDays = age / (24 * 60 * 60 * 1000);
        const weight = ageInDays > 30 ? 0.5 : 1.0;

        // Mark resolved
        await sbUpdate('ghost_calls', { id: call.id }, {
          status: 'resolved',
          outcome,
          exit_price: currentPrice,
          move_pct: parseFloat(movePct.toFixed(2)),
          resolved_at: new Date().toISOString(),
          weight,
        });

        // Correction log for high-conviction losses
        if (outcome === 'loss' && (call.conviction ?? 0) >= 7) {
          const mistakeType = getMistakeType(call, movePct);
          const dir = movePct > 0 ? 'up' : 'down';
          const detail = `Called ${call.direction} on ${call.ticker} at $${entryPrice.toFixed(2)} (conviction ${call.conviction}/10). Price moved ${dir} ${absMov.toFixed(2)}% to $${currentPrice.toFixed(2)}.` +
            (call.session ? ` Session: ${call.session}.` : '') +
            (call.pattern ? ` Pattern: ${call.pattern}.` : '');
          await sbPost('ghost_corrections', {
            call_id: call.id,
            source: call.source,
            pattern: call.pattern ?? null,
            mistake_type: mistakeType,
            detail,
            learned: buildLearnedNote(call, mistakeType),
          });
        }

        // Guard 7: skip snapshot for low-confidence calls
        if (!call.low_confidence) {
          await updateSnapshot(call.source, outcome, call.conviction, absMov, confidenceVsReality);
        }

        resolved++;
        log.push(`${outcome.toUpperCase()} ${call.ticker} ${call.direction} ${movePct > 0 ? '+' : ''}${movePct.toFixed(2)}% (${call.source})`);
      } catch (callErr) {
        skipped++;
        log.push(`ERR ${call.ticker}: ${callErr.message}`);
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message, resolved, skipped });
  }

  const duration = Date.now() - startTime;
  console.log(`[ghost-resolve] ${resolved} resolved, ${skipped} skipped, ${deadLettered} dead-lettered in ${duration}ms`);
  console.log('[ghost-resolve] log:', log.join(' | '));

  return res.status(200).json({
    ok: true,
    resolved,
    skipped,
    deadLettered,
    duration_ms: duration,
    log,
    time: new Date().toISOString(),
  });
};
