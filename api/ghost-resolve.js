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

// ─── Fetch live price ─────────────────────────────────────────────────────────

async function getLivePrice(ticker) {
  // Try Polygon — Options Advanced plan only:
  //   v2/last/stocks  → live last trade price (market hours)
  //   v2/aggs/prev    → previous close (24/7 fallback)
  // NOTE: v2/snapshot/locale/us/markets/stocks is NOT in Options Advanced — always 403
  if (POLYGON_KEY) {
    try {
      let livePrice = 0;
      let liveVolume = 0;

      // Live last trade (works during market hours)
      const lastRes = await fetch(
        `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(ticker)}?apiKey=${POLYGON_KEY}`,
        { headers: { 'User-Agent': 'Helios-Ghost/1.0' } }
      );
      if (lastRes.ok) {
        const d = await lastRes.json();
        livePrice = d?.results?.p ?? d?.last?.price ?? 0;
      }

      // Prev-day agg — always works, gives us prevClose + volume
      const prevRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`,
        { headers: { 'User-Agent': 'Helios-Ghost/1.0' } }
      );
      if (prevRes.ok) {
        const d = await prevRes.json();
        const bar = d?.results?.[0];
        if (bar) {
          liveVolume = bar.v ?? 0;
          if (!livePrice) livePrice = bar.c ?? 0;
        }
      }

      if (livePrice) return { price: livePrice, volume: liveVolume, source: 'polygon' };
    } catch (e) {
      console.warn('[ghost-resolve] Polygon failed:', e.message);
    }
  }

  // Yahoo Finance fallback
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios-Ghost/1.0)', Accept: 'application/json' } }
    );
    if (res.ok) {
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return {
          price: meta.regularMarketPrice,
          volume: meta.regularMarketVolume ?? 0,
          source: 'yahoo',
        };
      }
    }
  } catch (e) {
    console.warn('[ghost-resolve] Yahoo failed:', e.message);
  }

  return null;
}

// ─── Supabase helpers (raw fetch — no SDK in cron context) ───────────────────

async function sbGet(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`sbGet ${path} → ${res.status}`);
  return res.json();
}

async function sbPatch(path, match, body) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, `eq.${v}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPatch ${path} → ${res.status}`);
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sbPost ${path} → ${res.status}`);
}

// ─── Session label from timestamp ────────────────────────────────────────────

function sessionFromTimestamp(ts) {
  const ct = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const total = ct.getHours() * 60 + ct.getMinutes();
  if (total < 8 * 60 + 30) return 'premarket';
  if (total < 9 * 60 + 45) return 'open';
  if (total < 12 * 60) return 'midday';
  if (total < 14 * 60) return 'afternoon';
  if (total <= 15 * 60) return 'power_hour';
  return 'afterhours';
}

// ─── Determine mistake type ───────────────────────────────────────────────────

function getMistakeType(call, movePct) {
  if ((call.conviction ?? 0) >= 8 && Math.abs(movePct) > 1) return 'overconfident';
  if (call.direction && Math.sign(movePct) !== 0) return 'direction_wrong';
  if ((call.iv_rank ?? 0) > 70) return 'iv_mismatch';
  return 'timing_off';
}

function buildLearnedNote(call, mistakeType) {
  switch (mistakeType) {
    case 'overconfident':
      return `Reduce conviction when ${call.pattern || 'this setup'} appears${call.session ? ` in ${call.session}` : ''}. High confidence called but direction was wrong — recalibrate.`;
    case 'direction_wrong':
      return `${call.pattern || call.source} setup predicted ${call.direction} incorrectly. Review confluence conditions before committing to direction.`;
    case 'iv_mismatch':
      return `IV Rank ${call.iv_rank?.toFixed?.(0) ?? '?'} may have suppressed the expected move. High IV environments distort directional plays.`;
    case 'timing_off':
      return `${call.session ? `${call.session} session` : 'Timing'} was not optimal for this play. Consider session-specific filters.`;
    default:
      return 'Review setup conditions and adjust analysis weight.';
  }
}

// ─── Update daily accuracy snapshot ──────────────────────────────────────────

async function updateSnapshot(source, outcome, conviction, movePct, calibration) {
  const today = new Date().toISOString().split('T')[0];

  let existing = null;
  try {
    const rows = await sbGet('ghost_accuracy_snapshots', {
      snapshot_date: `eq.${today}`,
      source: `eq.${source}`,
      select: '*',
      limit: '1',
    });
    existing = rows?.[0] ?? null;
  } catch { /* first entry */ }

  const totalCalls = (existing?.total_calls ?? 0) + 1;
  const wins = (existing?.wins ?? 0) + (outcome === 'win' ? 1 : 0);
  const losses = (existing?.losses ?? 0) + (outcome === 'loss' ? 1 : 0);
  const scratches = (existing?.scratches ?? 0) + (outcome === 'scratch' ? 1 : 0);
  const winRate = Math.round((wins / totalCalls) * 100);

  const avgConviction = conviction != null
    ? ((existing?.avg_conviction ?? 0) * (totalCalls - 1) + conviction) / totalCalls
    : existing?.avg_conviction ?? 0;

  const avgMove = ((existing?.avg_actual_move ?? 0) * (totalCalls - 1) + movePct) / totalCalls;
  const avgCal = calibration != null
    ? ((existing?.calibration_score ?? 0) * (totalCalls - 1) + calibration) / totalCalls
    : existing?.calibration_score ?? 0;

  const payload = {
    snapshot_date: today,
    source,
    total_calls: totalCalls,
    wins, losses, scratches,
    win_rate: winRate,
    avg_conviction: Math.round(avgConviction * 10) / 10,
    avg_actual_move: Math.round(avgMove * 100) / 100,
    calibration_score: Math.round(avgCal * 100) / 100,
  };

  if (existing) {
    await sbPatch('ghost_accuracy_snapshots', { snapshot_date: today, source }, payload);
  } else {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ghost_accuracy_snapshots`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`snapshot upsert → ${res.status}`);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = req.headers.authorization ?? '';
  const secret = authHeader.replace('Bearer ', '');
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isMarketHours()) {
    return res.status(200).json({ ok: true, skipped: 0, resolved: 0, reason: 'outside market hours' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase config' });
  }

  const startTime = Date.now();
  let resolved = 0;
  let skipped = 0;
  let deadLettered = 0;
  const log = [];

  try {
    // Fetch all pending ghost calls older than 15 min
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const calls = await sbGet('ghost_calls', {
      status: 'eq.pending',
      created_at: `lt.${cutoff}`,
      select: '*',
      order: 'created_at.asc',
      limit: '50',
    });

    for (const call of calls) {
      try {
        // Dead letter after 3 attempts
        const attempts = (call.resolve_attempts ?? 0) + 1;
        if (attempts > 3) {
          await sbPatch('ghost_calls', { id: call.id }, { status: 'dead_letter', resolve_attempts: attempts });
          deadLettered++;
          log.push(`DEAD ${call.ticker} (${attempts} attempts)`);
          continue;
        }

        await sbPatch('ghost_calls', { id: call.id }, { resolve_attempts: attempts });

        const priceData = await getLivePrice(call.ticker);
        if (!priceData?.price) {
          skipped++;
          log.push(`SKIP ${call.ticker} — no price`);
          continue;
        }

        const currentPrice = priceData.price;
        const entryPrice   = call.entry_price ?? call.price ?? 0;
        if (!entryPrice) {
          skipped++;
          log.push(`SKIP ${call.ticker} — no entry price`);
          continue;
        }

        const movePct  = ((currentPrice - entryPrice) / entryPrice) * 100;
        const absMov   = Math.abs(movePct);
        const isUp     = movePct > 0;
        const isCall   = call.direction === 'calls' || call.direction === 'up' || call.direction === 'bullish';
        const isPut    = call.direction === 'puts'  || call.direction === 'down' || call.direction === 'bearish';

        let outcome = 'scratch';
        if (absMov >= 1.0) {
          if ((isCall && isUp) || (isPut && !isUp)) outcome = 'win';
          else outcome = 'loss';
        }

        const confidenceVsReality = call.conviction != null
          ? Math.round(((call.conviction / 10) - (outcome === 'win' ? 1 : outcome === 'loss' ? 0 : 0.5)) * 100)
          : null;

        const session = sessionFromTimestamp(call.created_at);

        await sbPatch('ghost_calls', { id: call.id }, {
          status: 'resolved',
          outcome,
          exit_price: currentPrice,
          actual_move_pct: Math.round(movePct * 100) / 100,
          resolved_at: new Date().toISOString(),
          session: call.session ?? session,
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
