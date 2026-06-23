module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Vercel.' });
  }

  const { messages, context } = req.body ?? {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const mode = context?.mode ?? 'chat';
  const isDeep = mode === 'deep_analysis' || mode === 'post_trade_autopsy' || mode === 'scenario_planner';
  const maxTokens = isDeep ? 900 : mode === 'morning-briefing' ? 700 : 450;

  const systemPrompt = buildSystemPrompt(context ?? {});
  const claudeMessages = normalizeMessages(messages);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[ai-chat] Anthropic error:', response.status, errText);
      return res.status(response.status).json({ error: 'AI service error: ' + response.status });
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text ?? '';
    const intent = parseIntent(text, messages);

    return res.status(200).json({ text, intent });
  } catch (err) {
    console.error('[ai-chat] Error:', err);
    return res.status(500).json({ error: 'AI request failed' });
  }
};

// ─── Normalize messages ────────────────────────────────────────────────────────

function normalizeMessages(messages) {
  var filtered = messages.filter(function(m) {
    return m && (m.role === 'user' || m.role === 'assistant') &&
           (typeof m.content === 'string' && m.content.trim().length > 0 || m.image);
  });
  var result = [];
  for (var i = 0; i < filtered.length; i++) {
    var msg = filtered[i];
    var last = result[result.length - 1];
    var content;
    if (msg.image && msg.role === 'user') {
      var base64Data = msg.image.replace(/^data:image\/\w+;base64,/, '');
      var mimeType = (msg.image.match(/^data:(image\/\w+);base64,/) || [])[1] || 'image/jpeg';
      content = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
        { type: 'text', text: msg.content || 'Analyze this chart. What do you see? What are the key levels, trend, and best play?' }
      ];
      result.push({ role: 'user', content });
      continue;
    }
    content = typeof msg.content === 'string' ? msg.content : '';
    if (last && last.role === msg.role && typeof last.content === 'string') {
      last.content += '\n' + content;
    } else {
      result.push({ role: msg.role, content });
    }
  }
  if (result[0] && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: 'Hello' });
  }
  return result.slice(-12);
}

// ─── Intent parsing ────────────────────────────────────────────────────────────

function parseIntent(aiReply, messages) {
  void aiReply;
  var reversed = messages.slice().reverse();
  var lastUserMsg = reversed.find(function(m) { return m.role === 'user'; });
  var lastUser = (lastUserMsg && lastUserMsg.content) ? lastUserMsg.content.toLowerCase() : '';

  var navMap = {
    dashboard: ['dashboard', 'home', 'overview'],
    scanner: ['scanner', 'scan', 'intraday'],
    signals: ['signals', 'signal feed', 'elite plays'],
    journal: ['journal', "i'm in", 'trades', 'paper trade'],
    options: ['options', 'options chain', 'chain'],
    chart: ['chart scan', 'chart', 'chart analysis'],
    brain: ['brain', 'helios brain', 'ghost'],
    settings: ['settings', 'preferences'],
  };

  var pages = Object.keys(navMap);
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var keywords = navMap[page];
    var hasNav = lastUser.includes('go to') || lastUser.includes('open') ||
      lastUser.includes('show me') || lastUser.includes('take me') ||
      lastUser.includes('navigate');
    if (hasNav && keywords.some(function(k) { return lastUser.includes(k); })) {
      var tickerMatch = lastUser.match(/\b([A-Z]{2,5})\b/);
      return { name: 'navigate', args: { page: page, ticker: tickerMatch ? tickerMatch[1] : null } };
    }
  }

  var watchMatch = lastUser.match(/add\s+([A-Z]{1,5})\s+to\s+(?:my\s+)?watchlist/i);
  if (watchMatch) return { name: 'add_watchlist', args: { ticker: watchMatch[1].toUpperCase() } };

  var alertMatch = lastUser.match(/(?:set|create|add)\s+(?:an?\s+)?alert\s+(?:for\s+)?([A-Z]{1,5})\s+(?:at|when|if)?\s*\$?([\d.]+)/i);
  if (alertMatch) {
    var dir = (lastUser.includes('below') || lastUser.includes('drops')) ? 'below' : 'above';
    return { name: 'set_alert', args: { ticker: alertMatch[1].toUpperCase(), price: parseFloat(alertMatch[2]), direction: dir } };
  }

  if (/best contracts?|top picks?|what should i trade|show.{0,10}picks/i.test(lastUser)) {
    return { name: 'show_best_contracts', args: {} };
  }

  var analyzeMatch = lastUser.match(/(?:analyze|analysis|tell me about|check|look at)\s+([A-Z]{1,5})\b/i);
  if (analyzeMatch) {
    return { name: 'analyze_ticker', args: { ticker: analyzeMatch[1].toUpperCase(), focus: 'full' } };
  }

  return null;
}

// ─── System prompt builder — ALL 7 LAYERS + SIGNAL AUTOPSY ───────────────────

function buildSystemPrompt(context) {
  var mode          = context.mode ?? 'chat';
  var time          = context.time;
  var marketBias    = context.marketBias;
  var topSignals    = context.topSignals ?? [];
  var activeTrades  = context.activeTrades ?? [];
  var watchlist     = context.watchlist ?? [];
  var bestContracts = context.bestContracts ?? [];
  var ghostStats    = context.ghostStats;
  var brainStats    = context.brainStats;
  var newsHeadlines = context.newsHeadlines ?? [];
  var accountSize   = context.accountSize;
  var riskTolerance = context.riskTolerance;
  var tradeHistory  = context.tradeHistory;
  var liveMarket    = context.liveMarket    ?? '';
  var traderFP      = context.traderFP      ?? '';
  var macroIntel    = context.macroIntel    ?? '';
  var brainCombos   = context.brainCombos   ?? '';
  var disciplineCtx = context.disciplineCtx ?? '';
  var activeCtx     = context.activeCtx     ?? '';
  var optionsFlow   = context.optionsFlow   ?? '';
  // Layer 0: Rich session context from client
  var sessionContext = context.sessionContext ?? '';
  // Counterfactual: skipped signal outcomes
  var counterfactual = context.counterfactual ?? null;

  void mode;

  var now      = time ? new Date(time) : new Date();
  var etDate   = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var etHour   = etDate.getHours();
  var etMin    = etDate.getMinutes();
  var etDow    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][etDate.getDay()];
  var etH12    = etHour % 12 === 0 ? 12 : etHour % 12;
  var etAMPM   = etHour < 12 ? 'AM' : 'PM';
  var etTimeStr = etH12 + ':' + String(etMin).padStart(2,'0') + ' ' + etAMPM + ' ET';
  var session  = sessionContext ||
    (etHour < 9 || (etHour === 9 && etMin < 30) ? 'Pre-Market' :
     (etHour === 9 && etMin < 60) ? 'Market Open (highest volatility)' :
     etHour < 12 ? 'Morning session' :
     etHour < 14 ? 'Midday chop zone' :
     etHour < 15 ? 'Afternoon session' :
     etHour < 16 ? 'Power Hour' : 'After Hours') +
    ' — ' + etDow + ' ' + etTimeStr;

  var tradesDetail = activeTrades.length
    ? activeTrades.map(function(t) {
        var pnl    = (t.pnlPct > 0 ? '+' : '') + t.pnlPct.toFixed(1) + '%';
        var held   = t.minutesHeld != null ? t.minutesHeld + 'm held' : '';
        var strike = t.strike  ? '$' + t.strike  : '';
        var expiry = t.expiry  ? 'exp ' + t.expiry : '';
        var tiers  = t.exitTiersHit ? t.exitTiersHit + ' tiers hit' : '0 tiers hit';
        var hwm    = t.highWaterMark ? ' | max: +' + t.highWaterMark.toFixed(0) + '%' : '';
        return [t.symbol, t.direction ? t.direction.toUpperCase() : '', strike, expiry, pnl, held, tiers + hwm].filter(Boolean).join(' | ');
      }).join('\n')
    : 'No active trades';

  var contractsDetail = bestContracts.length
    ? bestContracts.map(function(c) {
        return c.symbol + ' ' + c.direction.toUpperCase() + ' $' + c.strike + ' exp ' + c.expiry + ' (score ' + c.score + ')';
      }).join(', ')
    : 'none loaded';

  var brainLines = [];
  if (ghostStats) {
    brainLines.push('Ghost: ' + ghostStats.overallAccuracy + '% accuracy, ' + ghostStats.sessionAccuracy + '% recent');
  }
  if (brainStats && brainStats.totalTrades > 0) {
    brainLines.push('Your Brain: ' + brainStats.winRate + '% win rate | ' + brainStats.eliteRate + '% elite (100%+) | ' + brainStats.totalTrades + ' trades');
    if (brainStats.bestSession) brainLines.push('Best session: ' + brainStats.bestSession);
  }

  var newsLines = newsHeadlines.length
    ? newsHeadlines.slice(0, 6).map(function(n) {
        var tick = n.ticker || '';
        var sent = n.sentiment || 'neutral';
        var head = n.headline || n.title || '';
        return tick + ' [' + sent + ']: ' + head.slice(0, 80);
      }).join('\n')
    : 'No headlines loaded';

  var watchlistStr  = watchlist.length ? watchlist.join(', ') : 'AAPL, TSLA, SPY, QQQ, NVDA';

  var signalsDetail = topSignals.length
    ? topSignals.map(function(s) {
        var age = s.ageMinutes > 0 ? ' (' + s.ageMinutes + 'm ago)' : '';
        return s.symbol + ' → ' + s.signal.toUpperCase() + ' | ' + s.conviction + '% conviction | ' + (s.changePct >= 0 ? '+' : '') + s.changePct.toFixed(2) + '%' + age;
      }).join('\n')
    : 'No signals loaded yet';

  var profileDetail = [
    accountSize   ? 'Account size: $' + accountSize   : '',
    riskTolerance ? 'Risk tolerance: ' + riskTolerance : '',
    tradeHistory  ? 'Trade history note: ' + tradeHistory : '',
  ].filter(Boolean).join(' | ') || 'Profile not set';

  // ── Build counterfactual section ─────────────────────────────────────────────
  var counterfactualSection = (function() {
    if (!counterfactual || !counterfactual.stats || counterfactual.stats.totalSignals === 0) return '';
    var s = counterfactual.stats;
    var lines = ['═══ SESSION SIGNAL AUTOPSY (What You Left On The Table) ═══'];
    lines.push('Signals fired: ' + s.totalSignals + ' | Taken: ' + (s.totalSignals - s.skippedSignals) + ' | Skipped: ' + s.skippedSignals);
    lines.push('Taken win rate: ' + s.takenWinRate + '% | Skipped signal win rate: ' + s.skippedWinRate + '%');
    if (s.missedElites > 0) lines.push('MISSED ELITE setups (100%+ options gain): ' + s.missedElites);
    if (s.missedWins > 0)   lines.push('Missed wins (any positive outcome skipped): ' + s.missedWins);
    if (counterfactual.skippedSignals && counterfactual.skippedSignals.length > 0) {
      lines.push('');
      lines.push('Resolved skipped signals:');
      counterfactual.skippedSignals.forEach(function(sig) {
        var move = sig.movePct != null ? (sig.movePct >= 0 ? '+' : '') + sig.movePct.toFixed(1) + '%' : '?';
        var pnl  = sig.optionPnlProxy != null ? ' (~option: ' + (sig.optionPnlProxy >= 0 ? '+' : '') + sig.optionPnlProxy.toFixed(0) + '%)' : '';
        lines.push('  ' + sig.symbol + ' ' + sig.direction.toUpperCase() + ' @ $' + sig.entryPrice + ' [' + sig.firedAt + '] → moved ' + move + pnl + ' | ' + sig.outcome.toUpperCase());
      });
    }
    lines.push('');
    lines.push('When user asks about missed trades or what they left on the table — use THIS data. Be direct and specific.');
    return lines.join('\n') + '\n';
  })();

  var optionsKnowledge = [
    '═══════════════════════════════════════════════════════════════════',
    'HELIOS SUPER-AGENT — PROFESSIONAL OPTIONS TRADING KNOWLEDGE BASE',
    'This is your permanent expert foundation. Apply this to every answer.',
    '═══════════════════════════════════════════════════════════════════',
    '',
    '── THE GREEKS ──────────────────────────────────────────────────────',
    'DELTA: Probability proxy + directional exposure.',
    '  0.50 = ATM. 0.70 = ITM (safer, lower ROI). 0.30 = OTM (higher ROI, needs bigger move).',
    '  Rule: ATM options (delta 0.45-0.55) offer the best balance of cost vs. directional exposure.',
    '',
    'GAMMA: Rate of change of delta.',
    '  Highest near ATM and near expiry. 0DTE ATM options have extreme gamma after 1pm CT.',
    '  Rule: High gamma = lottery ticket behavior. Size smaller.',
    '',
    'THETA: Time decay — your enemy on long trades.',
    '  0DTE: Catastrophic after 12pm CT. 1-7 DTE: Moderate. 14-30 DTE: Slow.',
    '  Rule: On 0DTE, enter with a thesis and exit within 30-60 minutes.',
    '',
    'VEGA: Exposure to IV changes. Long options benefit from IV expansion.',
    '  After a catalyst resolves (earnings, FOMC), IV collapses 40-70% — IV crush.',
    '  Rule: Buy options BEFORE IV expands, never after. IV Rank > 80 = overpriced.',
    '',
    '── IMPLIED VOLATILITY ──────────────────────────────────────────────',
    'IV Rank 0-20: Options CHEAP. Best for buying outright calls/puts.',
    'IV Rank 20-50: Normal. Standard sizing.',
    'IV Rank 50-75: Elevated. Reduce size. Consider spreads.',
    'IV Rank 75-100: EXPENSIVE. Selling premium has edge. Avoid naked buys.',
    '',
    'IV CRUSH: Buying into earnings = buying at peak IV. Even correct direction can lose.',
    '  Rule: Never buy options into earnings unless expected move is 2x the priced move.',
    '',
    '── OPTIONS PRICING ─────────────────────────────────────────────────',
    'Premium = Intrinsic Value + Extrinsic Value (time + IV).',
    'Breakeven: Strike + Premium (calls), Strike - Premium (puts).',
    'Deep OTM (delta < 0.20): >85% expire worthless. Avoid unless 90%+ conviction.',
    '',
    '── STRATEGY ARCHETYPES ─────────────────────────────────────────────',
    'DIRECTIONAL MOMENTUM: ATM/slight OTM, 0-7 DTE. Target +50-100%, stop -25-30%.',
    'SWING TRADE: ITM/ATM, 14-30 DTE. Target +30-80%, stop -30-40%.',
    'VERTICAL SPREAD: Use when IV Rank > 60. Defined risk, capped upside.',
    'STRADDLE: ATM call + put. Profits from large move in either direction.',
    '',
    '── PATTERN RECOGNITION ─────────────────────────────────────────────',
    'VWAP RECLAIM: Price reclaims VWAP on volume → CALL entry.',
    'GAP-AND-FAIL: Gaps up then fades below gap → PUT entry.',
    'BULL FLAG: Strong move, tight consolidation, breakout on volume → CALL.',
    'EXHAUSTION: Extreme volume + long wick candle → reversal likely.',
    'OPENING RANGE BREAKOUT: Break above ORH on volume → CALL. Below ORL → PUT.',
    'MOMENTUM FADE: First sign of deceleration after big move → exit.',
    '',
    '── RISK MANAGEMENT (non-negotiable) ────────────────────────────────',
    '1. Never risk more than 2-5% of account per trade.',
    '2. Hard stops: -25% (0DTE), -30% (1-7 DTE), -35% (swing).',
    '3. At +50% gain, scale out 30-50%. Let rest ride with trailing stop.',
    '4. Never hold options through earnings unless selling premium.',
    '5. 3+ calls in same sector = concentrated risk. Size accordingly.',
    '6. 0DTE: Exit by 2:30pm CT. Theta is exponential near close.',
    '7. More than 5 trades/day = decision fatigue. Stop after 3 losses.',
    '8. IV Rank > 80 = overpaying. Need very strong catalyst to justify.',
    '9. Never buy calls below VWAP. Never buy puts above VWAP.',
    '',
    '── SESSION TIMING ──────────────────────────────────────────────────',
    'OPEN 9:30-10:00 CT: Highest volatility. Wait 5-15 min before entering.',
    'MID-MORNING 10:00-11:30 CT: Trend confirms. Best signal quality.',
    'MIDDAY 11:30-13:30 CT: Low volume chop. Reduce size 50%. Avoid new entries.',
    'AFTERNOON 13:30-14:00 CT: Institutions positioning for close.',
    'POWER HOUR 14:00-15:00 CT: Elevated volume. High-probability continuation.',
    'FINAL 30MIN 15:00-15:30 CT: Very high risk. Do not initiate new trades.',
    '',
    '── OPEX DYNAMICS ───────────────────────────────────────────────────',
    'GEX: Market makers hedge as price approaches large OI strikes.',
    'Max Pain: Strike where most options expire worthless. Price gravitates here.',
    'OpEx Friday: Violent moves near large strikes. Size down. Tighter stops.',
    '',
    '── MARKET REGIME ───────────────────────────────────────────────────',
    'TRENDING: Momentum plays work. Buy directional, hold longer, trail stops.',
    'RANGE-BOUND: Fade the extremes. Spreads better than naked.',
    'HIGH-VOL SHOCK (VIX >25): Options expensive. Wait for exhaustion, then fade.',
    'EARNINGS SEASON: IV elevated. Spreads and defined-risk plays preferred.',
  ].join('\n');

  return [
    '╔══════════════════════════════════════════════════════╗',
    '║  HELIOS — PROFESSIONAL OPTIONS TRADING AI ADVISOR   ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    'You are Helios — an elite AI trading advisor with professional options trading',
    'knowledge. You have the full knowledge base below PLUS live data about the',
    'current market, the specific trader you are advising, and their trade history.',
    '',
    'PERSONA: Sharp, direct, confident like a seasoned prop desk trader.',
    'Never a salesman. Never a textbook. Real talk, real numbers.',
    'ALWAYS frame as analysis and education, never financial advice or guarantees.',
    '',
    '═══ CURRENT SESSION ═══',
    session,
    'Market bias: ' + (marketBias || 'neutral / loading'),
    'Watchlist: ' + watchlistStr,
    '',
    '═══ LIVE SIGNALS ═══',
    signalsDetail,
    '',
    '═══ ACTIVE TRADES ═══',
    tradesDetail,
    '',
    '═══ BEST CONTRACTS NOW ═══',
    contractsDetail,
    '',
    '═══ BRAIN INTELLIGENCE ═══',
    brainLines.length ? brainLines.join('\n') : 'Brain: no data yet',
    '',
    '═══ NEWS CATALYST FEED ═══',
    newsLines,
    '',
    '═══ TRADER PROFILE ═══',
    profileDetail,
    '',
    liveMarket    ? liveMarket    + '\n' : '',
    traderFP      ? traderFP      + '\n' : '',
    macroIntel    ? macroIntel    + '\n' : '',
    optionsFlow   ? '═══ OPTIONS FLOW (institutional) ═══\n' + optionsFlow + '\n' : '',
    brainCombos   ? brainCombos   + '\n' : '',
    disciplineCtx ? disciplineCtx + '\n' : '',
    activeCtx     ? activeCtx     + '\n' : '',

    // ── Counterfactual: skipped signal autopsy ────────────────────────────────
    counterfactualSection,

    optionsKnowledge,
    '',
    '═══ RESPONSE RULES — NEVER BREAK ═══',
    '1. SHORT by default: 2-3 sentences unless user asks for deep analysis.',
    '2. NUMBERS: Always use actual data from context. Never make up prices or P&L.',
    '3. EXIT ADVICE: Check P&L %, minutes held, tier hits, theta risk, Brain hold window.',
    '4. ENTRY ADVICE: Check VWAP side, session timing, IV rank, signal age, correlation.',
    '5. SIGNAL AGE > 30min: WARN — "Signal is X minutes old — verify chart before entering."',
    '6. NEWS CONFLICT: If news conflicts with signal direction, flag it explicitly.',
    '7. NEWS CONFIRMS: If news confirms signal direction, mention it as a tailwind.',
    '8. TILT ALERT: If traderFP shows tilt, lead with a discipline reminder.',
    '9. POWER HOUR (after 14:00 CT): Warn that new entries add session risk.',
    '10. IV RANK > 80: Flag expensive premium — suggest spread instead of naked buy.',
    '11. MARKET CLOSED: Pivot to planning, education, Brain review, or journal analysis.',
    '12. EARNINGS < 3 days: Flag IV crush risk loudly.',
    '13. CORRELATION: If 3+ correlated positions, flag concentrated risk.',
    '14. DISCIPLINE: Praise discipline. Call out revenge trades kindly.',
    '15. POST-TRADE AUTOPSY: Be specific, honest, reference Brain history patterns.',
    '16. SCENARIO mode: Give 3 clear scenarios with specific price levels and action steps.',
    '17. RE-ENTRY WINDOWS: Reference trigger type and time left if active.',
    '18. BRAIN SUPPRESS: If Brain flags ticker as unreliable (high miss rate), warn user.',
    '19. HOT PATTERNS: If Brain found hot patterns matching this setup, mention them.',
    '20. COLD STRATEGIES: If strategy is in Brain cold rotation, warn user.',
    '21. AUTOPSY REFERENCE: If recent autopsies show repeat mistakes, call it out.',
    '22. SESSION WIN RATES: Reference user session win rates when giving timing advice.',
    '23. VWAP: Above VWAP = calls bias. Below = puts bias. Always reference on entry.',
    '24. HOLD WINDOW: Always give specific range (e.g. "5-20 min for SCALP").',
    '25. 0DTE THETA CLIFF: Warn loudly if past 1:30 PM CT on a 0DTE position.',
    '26. CURRENT TIME: Use exact ET time from session — e.g. "It\'s 10:22 AM ET, morning session."',
    '27. GHOST COMPARISON: If Ghost outperformed on this setup, mention it.',
    '28. PRE-MARKET: Warn about thin liquidity and wide spreads.',
    '29. CANDLES: 5 consecutive lower closes = mention bearish pressure.',
    '30. GREEKS: Reference delta, gamma, theta from options snapshot when relevant.',
    '31. FOMC DAY: Lead every entry question with "FOMC day — past the freeze zone?"',
    '32. FOMC FREEZE: If BLACKOUT/FREEZE in context: "No new entries. Protect open positions only."',
    '33. POST-FOMC: "First FOMC move is almost always a fake-out. Wait 10-15 min for real direction."',
    '34. IV CRUSH WARNING: If big event < 120 min away with open positions, warn about IV collapse.',
    '35. STRADDLE WINDOW: If FOMC 90-30 min away, suggest ATM straddle.',
    '36. GEO RISK: If elevated, tighten stops 10%, avoid new swings.',
    '37. LIVE DATA: NEVER say you lack live data. Always proceed with analysis.',
    '38. NEVER ASK FOR DATA: You have market access. Use it. Never ask user for prices or IV.',
    '39. MISSED TRADES AUTOPSY: When user asks "what did I miss?", "what did I leave on the table?", "session autopsy", "what signals did I skip?", or similar — use the SESSION SIGNAL AUTOPSY section above. List every skipped signal with its outcome and estimated option P&L, calculate the total missed gains, identify the single best setup they passed on. Be direct and specific. NEVER ask them questions or say you need more info.',
  ].filter(Boolean).join('\n');
}
    '36. GEO RISK: If elevated, tighten stops 10%, avoid new swings.',
    '37. LIVE DATA: NEVER say you lack live data. Always proceed with analysis.',
    '38. NEVER ASK FOR DATA: You have market access. Use it. Never ask user for prices or IV.',
  ].filter(Boolean).join('\n');
}
