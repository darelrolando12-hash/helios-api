module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Vercel.' });
  }

  var body = req.body || {};
  var messages = body.messages;
  var context  = body.context || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  var mode      = context.mode || 'chat';
  var isDeep    = mode === 'deep_analysis' || mode === 'post_trade_autopsy' || mode === 'scenario_planner';
  var maxTokens = isDeep ? 900 : mode === 'morning-briefing' ? 700 : 450;

  var systemPrompt   = buildSystemPrompt(context);
  var claudeMessages = normalizeMessages(messages);

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
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
      var errText = await response.text();
      console.error('[ai-chat] Anthropic error:', response.status, errText);
      return res.status(response.status).json({ error: 'AI service error: ' + response.status });
    }

    var data   = await response.json();
    var text   = (data && data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    var intent = parseIntent(text, messages);

    return res.status(200).json({ text: text, intent: intent });
  } catch (err) {
    console.error('[ai-chat] Error:', err);
    return res.status(500).json({ error: 'AI request failed' });
  }
};

// ─── Normalize messages (with vision support) ────────────────────────────────

function normalizeMessages(messages) {
  var filtered = messages.filter(function(m) {
    return m && (m.role === 'user' || m.role === 'assistant') &&
           (typeof m.content === 'string' && m.content.trim().length > 0 || m.image);
  });
  var result = [];
  for (var i = 0; i < filtered.length; i++) {
    var msg  = filtered[i];
    var last = result[result.length - 1];
    var content;

    if (msg.image && msg.role === 'user') {
      var base64Data = msg.image.replace(/^data:image\/\w+;base64,/, '');
      var mimeMatch  = msg.image.match(/^data:(image\/\w+);base64,/);
      var mimeType   = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      content = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
        { type: 'text', text: msg.content || 'Analyze this chart. What do you see? What are the key levels, trend, and best play?' }
      ];
      result.push({ role: 'user', content: content });
      continue;
    }

    content = typeof msg.content === 'string' ? msg.content : '';
    if (last && last.role === msg.role && typeof last.content === 'string') {
      last.content += '\n' + content;
    } else {
      result.push({ role: msg.role, content: content });
    }
  }
  if (result[0] && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: 'Hello' });
  }
  return result.slice(-12);
}

// ─── Intent parsing ───────────────────────────────────────────────────────────

function parseIntent(aiReply, messages) {
  void aiReply;
  var reversed    = messages.slice().reverse();
  var lastUserMsg = reversed.find(function(m) { return m.role === 'user'; });
  var lastUser    = (lastUserMsg && lastUserMsg.content) ? lastUserMsg.content.toLowerCase() : '';

  var navMap = {
    dashboard: ['dashboard', 'home', 'overview'],
    scanner:   ['scanner', 'scan', 'intraday'],
    signals:   ['signals', 'signal feed', 'elite plays'],
    journal:   ['journal', "i'm in", 'trades', 'paper trade'],
    options:   ['options', 'options chain', 'chain'],
    chart:     ['chart scan', 'chart', 'chart analysis'],
    brain:     ['brain', 'helios brain', 'ghost'],
    settings:  ['settings', 'preferences'],
  };

  var pages = Object.keys(navMap);
  for (var i = 0; i < pages.length; i++) {
    var page     = pages[i];
    var keywords = navMap[page];
    var hasNav   = lastUser.includes('go to') || lastUser.includes('open') ||
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

// ─── System prompt builder — ALL 7 LAYERS ────────────────────────────────────

function buildSystemPrompt(context) {
  var mode          = context.mode          || 'chat';
  var time          = context.time;
  var marketBias    = context.marketBias;
  var topSignals    = context.topSignals    || [];
  var activeTrades  = context.activeTrades  || [];
  var watchlist     = context.watchlist     || [];
  var bestContracts = context.bestContracts || [];
  var ghostStats    = context.ghostStats;
  var brainStats    = context.brainStats;
  var newsHeadlines = context.newsHeadlines || [];
  var accountSize   = context.accountSize;
  var riskTolerance = context.riskTolerance;
  var tradeHistory  = context.tradeHistory;

  // Super-agent layers
  var liveMarket    = context.liveMarket    || '';
  var traderFP      = context.traderFP      || '';
  var macroIntel    = context.macroIntel    || '';
  var brainCombos   = context.brainCombos   || '';
  var disciplineCtx = context.disciplineCtx || '';
  var activeCtx     = context.activeCtx     || '';
  var optionsFlow   = context.optionsFlow   || '';

  // Layer 0: Rich session context from client
  var sessionContext = context.sessionContext || '';

  // Counterfactual: skipped signal outcomes
  var counterfactual = context.counterfactual || null;

  // Build session label
  var now    = time ? new Date(time) : new Date();
  var etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var etHour = etDate.getHours();
  var etMin  = etDate.getMinutes();
  var etDow  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][etDate.getDay()];
  var etH12  = etHour % 12 === 0 ? 12 : etHour % 12;
  var etAMPM = etHour < 12 ? 'AM' : 'PM';
  var etTimeStr = etH12 + ':' + String(etMin).padStart(2, '0') + ' ' + etAMPM + ' ET';
  var session = sessionContext ||
    (etHour < 9 || (etHour === 9 && etMin < 30) ? 'Pre-Market' :
     (etHour === 9 && etMin < 60) ? 'Market Open (highest volatility)' :
     etHour < 12 ? 'Morning session' :
     etHour < 14 ? 'Midday chop zone' :
     etHour < 15 ? 'Afternoon session' :
     etHour < 16 ? 'Power Hour' : 'After Hours') +
    ' — ' + etDow + ' ' + etTimeStr;

  // Trade detail
  var tradesDetail = activeTrades.length
    ? activeTrades.map(function(t) {
        var pnl    = (t.pnlPct > 0 ? '+' : '') + (t.pnlPct || 0).toFixed(1) + '%';
        var held   = t.minutesHeld != null ? t.minutesHeld + 'm held' : '';
        var strike = t.strike  ? '$' + t.strike  : '';
        var expiry = t.expiry  ? 'exp ' + t.expiry : '';
        var tiers  = t.exitTiersHit ? t.exitTiersHit + ' tiers hit' : '0 tiers hit';
        var hwm    = t.highWaterMark ? ' | max: +' + (t.highWaterMark || 0).toFixed(0) + '%' : '';
        return [t.symbol, t.direction ? t.direction.toUpperCase() : '', strike, expiry, pnl, held, tiers + hwm].filter(Boolean).join(' | ');
      }).join('\n')
    : 'No active trades';

  var contractsDetail = bestContracts.length
    ? bestContracts.map(function(c) {
        return c.symbol + ' ' + c.direction.toUpperCase() + ' $' + c.strike + ' exp ' + c.expiry + ' (score ' + c.score + ')';
      }).join(', ')
    : 'none loaded';

  var brainLines = [];
  if (ghostStats) brainLines.push('Ghost: ' + ghostStats.overallAccuracy + '% accuracy, ' + ghostStats.sessionAccuracy + '% recent');
  if (brainStats && brainStats.totalTrades > 0) {
    brainLines.push('Your Brain: ' + brainStats.winRate + '% win rate | ' + brainStats.eliteRate + '% elite (100%+) | ' + brainStats.totalTrades + ' trades');
    if (brainStats.bestSession) brainLines.push('Best session: ' + brainStats.bestSession);
  }

  var newsLines = newsHeadlines.length
    ? newsHeadlines.slice(0, 6).map(function(n) {
        var tick = n.ticker    || '';
        var sent = n.sentiment || 'neutral';
        var head = n.headline  || n.title || '';
        return tick + ' [' + sent + ']: ' + head.slice(0, 80);
      }).join('\n')
    : 'No headlines loaded';

  var watchlistStr = watchlist.length ? watchlist.join(', ') : 'AAPL, TSLA, SPY, QQQ, NVDA';

  var signalsDetail = topSignals.length
    ? topSignals.map(function(s) {
        var age = s.ageMinutes > 0 ? ' (' + s.ageMinutes + 'm ago)' : '';
        return s.symbol + ' → ' + s.signal.toUpperCase() + ' | ' + s.conviction + '% conviction | ' + (s.changePct >= 0 ? '+' : '') + (s.changePct || 0).toFixed(2) + '%' + age;
      }).join('\n')
    : 'No signals loaded yet';

  var profileDetail = [
    accountSize   ? 'Account size: $' + accountSize      : '',
    riskTolerance ? 'Risk tolerance: ' + riskTolerance    : '',
    tradeHistory  ? 'Trade history note: ' + tradeHistory : '',
  ].filter(Boolean).join(' | ') || 'Profile not set';

  // ── Build counterfactual section ──────────────────────────────────────────
  var counterfactualSection = '';
  if (counterfactual) {
    var lines = [];
    lines.push('═══ SESSION SIGNAL AUTOPSY ═══');
    var stats = counterfactual.stats;
    if (stats) {
      lines.push('Total signals this session: ' + (stats.totalSignals || 0));
      lines.push('Signals you took: '           + (stats.takenSignals || 0));
      lines.push('Signals you skipped: '        + (stats.skippedSignals || 0));
      lines.push('Taken win rate: '             + (stats.takenWinRate  != null ? stats.takenWinRate.toFixed(0)  + '%' : 'n/a'));
      lines.push('Skipped win rate: '           + (stats.skippedWinRate != null ? stats.skippedWinRate.toFixed(0) + '%' : 'n/a'));
      if (stats.missedElites) lines.push('Elite setups you SKIPPED: ' + stats.missedElites);
      if (stats.missedWins)   lines.push('Winning setups you SKIPPED: ' + stats.missedWins);
    }

    var skipped = counterfactual.skippedSignals || [];
    if (skipped.length > 0) {
      lines.push('');
      lines.push('Resolved skipped signals:');
      skipped.forEach(function(sig) {
        var move = sig.movePct != null
          ? (sig.movePct >= 0 ? '+' : '') + sig.movePct.toFixed(1) + '%'
          : '?';
        var pnl = sig.optionPnlProxy != null
          ? ' (~option: ' + (sig.optionPnlProxy >= 0 ? '+' : '') + sig.optionPnlProxy.toFixed(0) + '%)'
          : '';
        lines.push('  ' + sig.symbol + ' ' + (sig.direction || '').toUpperCase() +
          ' @ $' + sig.entryPrice +
          ' [' + sig.firedAt + '] → moved ' + move + pnl +
          ' | ' + (sig.outcome || 'unknown').toUpperCase());
      });
    }

    lines.push('');
    lines.push('IMPORTANT: When user asks about missed trades, trades they skipped, what they left on the table,');
    lines.push('or session autopsy — use THIS data to give a precise answer. Do NOT ask them for information.');
    lines.push('Calculate total missed P&L, identify the best skipped setup, and tell them directly.');
    counterfactualSection = lines.join('\n') + '\n';
  }

  // ══════════════════════════════════════════════════════════════════
  // LAYER 4: PERMANENT OPTIONS KNOWLEDGE BASE
  // ══════════════════════════════════════════════════════════════════
  var optionsKnowledge = [
    '═══════════════════════════════════════════════════════════════════',
    'HELIOS SUPER-AGENT — PROFESSIONAL OPTIONS TRADING KNOWLEDGE BASE',
    'This is your permanent expert foundation. Apply this to every answer.',
    '═══════════════════════════════════════════════════════════════════',
    '',
    '── THE GREEKS ──────────────────────────────────────────────────────',
    'DELTA: Probability proxy + directional exposure.',
    '  0.50 = ATM (50% chance ITM). 0.70 = ITM. 0.30 = OTM.',
    '  CALL delta positive (profits on up). PUT delta negative (profits on down).',
    '  Rule: ATM options (delta 0.45–0.55) offer best balance of cost vs. exposure.',
    '',
    'GAMMA: Rate of change of delta.',
    '  Highest near ATM, highest near expiry. 0DTE ATM options have extreme gamma after 1pm CT.',
    '  Rule: High gamma = lottery ticket behavior. Size smaller on high-gamma trades.',
    '',
    'THETA: Time decay — your option loses value every minute.',
    '  0DTE: Theta catastrophic after 12pm CT — loses 2–5% per hour in time value.',
    '  Rule: On 0DTE, enter with a thesis and exit within 30-60 minutes.',
    '',
    'VEGA: Exposure to IV changes. Long options = long vega (benefit from IV expansion).',
    '  After catalyst resolves, IV collapses 40–70% — this is IV crush.',
    '  Rule: Buy options BEFORE IV expands, never after. IV Rank > 80 = options overpriced.',
    '',
    'GAMMA-THETA tradeoff: More gamma (higher profit potential) = more theta (faster decay).',
    '',
    '── IV (IMPLIED VOLATILITY) ────────────────────────────────────────',
    'IV Rank 0–20: Options CHEAP. Favors buying outright calls/puts.',
    'IV Rank 20–50: Normal. Standard sizing and strategy.',
    'IV Rank 50–75: Elevated. Reduce size 20-30%. Consider spreads.',
    'IV Rank 75–100: EXPENSIVE. Selling premium has edge. Avoid naked buys.',
    '',
    'IV CRUSH (most common rookie killer):',
    '  Buying into earnings = buying at peak IV. Even right direction can lose.',
    '  Example: NVDA earnings up 5% → options bought pre-earnings DOWN 30% (IV dropped 60%).',
    '  Rule: Never buy options into earnings unless expected move is 2× the priced move.',
    '',
    '── OPTIONS PRICING ────────────────────────────────────────────────',
    'Option premium = Intrinsic Value + Extrinsic Value (time + IV premium)',
    'ATM: 100% extrinsic — paying for time and probability only.',
    'ITM: Mix of intrinsic + extrinsic. Acts more like stock.',
    'OTM: 100% extrinsic. High risk, needs large move. Only with very high conviction.',
    'Deep OTM (delta < 0.20): Lottery tickets. >85% expire worthless.',
    '',
    'BREAKEVEN: (Strike + Premium) for calls, (Strike - Premium) for puts.',
    'Rule: Always know your breakeven BEFORE entering.',
    '',
    '── STRATEGY ARCHETYPES ────────────────────────────────────────────',
    'DIRECTIONAL MOMENTUM (best for Helios signals):',
    '  Buy ATM or slight OTM call/put, 0-7 DTE. Target: 50%–100% gain. Stop: -25% to -30%.',
    '  Best in: MORNING session (9:30–10:30 CT) or POWER HOUR (14:00–15:00 CT).',
    '',
    'SWING TRADE (multi-day thesis):',
    '  Buy ITM or ATM, 14–30 DTE. Target: 30%–80% gain. Stop: -30% to -40%.',
    '  Best in: Low IV. Check earnings — do NOT hold through earnings.',
    '',
    'VERTICAL SPREAD (defined risk, high IV):',
    '  Buy lower strike, sell higher strike. Use when IV Rank > 60.',
    '',
    'STRADDLE (non-directional catalyst):',
    '  Buy ATM call + ATM put. Needs actual move to exceed implied move.',
    '  Rule: Only buy when you expect a surprise and IV is not already inflated.',
    '',
    '── PATTERN RECOGNITION ────────────────────────────────────────────',
    'VWAP RECLAIM: Price reclaims VWAP on volume → CALL entry signal.',
    'GAP-AND-FAIL: Stock gaps up, fades below gap → PUT signal.',
    'BULL FLAG: Strong move, tight consolidation, breakout → CALL entry.',
    'EXHAUSTION / CLIMAX: Extreme volume + long wick → reversal likely.',
    'OPENING RANGE BREAKOUT: Break above opening range high on volume → CALL.',
    'HEAD AND SHOULDERS: Distribution topping pattern → PUT setup.',
    'MOMENTUM FADE: Signal was strong, now decelerating → exit.',
    '',
    '── RISK MANAGEMENT (non-negotiable) ───────────────────────────────',
    '1. POSITION SIZING: Never risk more than 2–5% of account per trade.',
    '2. STOP LOSSES: Hard stop at -25% (0DTE), -30% (1-7 DTE), -35% (swing).',
    '3. SCALE OUT: At +50%, take 30-50% off. Let rest ride with trailing stop.',
    '4. EARNINGS RULE: Never hold options through earnings unless selling premium.',
    '5. CORRELATION: 3+ calls in same sector = ONE directional trade. Size accordingly.',
    '6. THETA RULE: On 0DTE, exit by 2:30pm CT unless clearly profitable.',
    '7. OVERTRADING: More than 5 trades/day = decision fatigue. Stop after 3 losses.',
    '8. IV RULE: Never buy IV Rank > 80 without very strong catalyst.',
    '9. VWAP RULE: Never buy calls below VWAP. Never buy puts above VWAP.',
    '',
    '── SESSION TIMING ─────────────────────────────────────────────────',
    'MARKET OPEN 9:30–10:00 CT: Highest volatility. Wait 5–15 min for chaos to settle.',
    'MID-MORNING 10:00–11:30 CT: Trend confirms. Best signal quality.',
    'MIDDAY 11:30–13:30 CT: Volume dries up. Chop. Reduce size 50%.',
    'AFTERNOON 13:30–14:00 CT: Institutions start positioning for close.',
    'POWER HOUR 14:00–15:00 CT: Elevated volume, high-probability continuations.',
    'FINAL 30MIN 15:00–15:30 CT: MOC orders. Very high risk. No new trades.',
    '',
    '── OPTIONS EXPIRATION (OpEx) ──────────────────────────────────────',
    'OpEx = 3rd Friday monthly + every Friday (0DTE weekly).',
    'Max Pain: Stocks often gravitate to strike where most options expire worthless.',
    'Rule on OpEx Friday: Expect violent moves near large strikes. Size down. Tighter stops.',
    '',
    '── MARKET REGIME ──────────────────────────────────────────────────',
    'TRENDING (SPY/QQQ >0.5% with above-avg volume): Momentum plays work. Hold longer.',
    'RANGE-BOUND (flat, low volume): Fade extremes. Spreads better than naked.',
    'HIGH-VOL SHOCK (VIX >25, SPY move >1.5%): Options expensive. Consider selling spreads.',
    'EARNINGS SEASON (Jan/Apr/Jul/Oct): IV elevated. Defined-risk plays preferred.',
  ].join('\n');

  // ══════════════════════════════════════════════════════════════════
  // ASSEMBLE FULL SYSTEM PROMPT
  // ══════════════════════════════════════════════════════════════════
  var parts = [
    '╔══════════════════════════════════════════════════════╗',
    '║  HELIOS — PROFESSIONAL OPTIONS TRADING AI ADVISOR   ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    'You are Helios — an elite AI trading advisor with decades of professional options',
    'trading knowledge. You have the full options knowledge base below, PLUS live data',
    'about the current market, the specific trader you are advising, and their trade history.',
    '',
    'PERSONA: Sharp, direct, confident like a seasoned prop desk trader.',
    'Never a salesman. Never a textbook. Real talk, real numbers.',
    'ALWAYS frame as analysis and education, never as financial advice or guarantees.',
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
  ];

  if (liveMarket)    parts.push(liveMarket    + '\n');
  if (traderFP)      parts.push(traderFP      + '\n');
  if (macroIntel)    parts.push(macroIntel    + '\n');
  if (brainCombos)   parts.push(brainCombos   + '\n');
  if (disciplineCtx) parts.push(disciplineCtx + '\n');
  if (activeCtx)     parts.push(activeCtx     + '\n');
  if (optionsFlow)   parts.push(optionsFlow   + '\n');

  if (counterfactualSection) parts.push(counterfactualSection);

  parts.push(optionsKnowledge);
  parts.push('');
  parts.push('═══ RESPONSE RULES — NEVER BREAK ═══');
  parts.push('1. SHORT by default: 2–3 sentences unless user asks for deep analysis or post-trade autopsy.');
  parts.push('2. NUMBERS: Always use actual data from context. Never make up prices, strikes, or P&L.');
  parts.push('3. EXIT ADVICE: Check P&L %, minutes held, tier hits, theta risk, Brain hold window.');
  parts.push('4. ENTRY ADVICE: Check VWAP side, session timing, IV rank, signal age, correlation.');
  parts.push('5. SIGNAL AGE > 30min: WARN — "Signal is X minutes old — verify chart before entering."');
  parts.push('6. NEWS CONFLICT: If news sentiment CONFLICTS with signal direction, flag it explicitly.');
  parts.push('7. NEWS CONFIRMS: If news sentiment CONFIRMS signal direction, mention it as tailwind.');
  parts.push('8. TILT ALERT: If traderFP shows tilt, lead with a discipline reminder before analysis.');
  parts.push('9. POWER HOUR (after 14:00 CT): Warn that new entries add session risk.');
  parts.push('10. IV RANK > 80: Flag expensive premium — suggest spread instead of naked buy.');
  parts.push('11. MARKET CLOSED: Pivot to planning, education, Brain review, or journal analysis.');
  parts.push('12. EARNINGS < 3 days: Flag IV crush risk loudly on any direction.');
  parts.push('13. CORRELATION: If 3+ correlated positions, flag concentrated risk.');
  parts.push('14. DISCIPLINE: Praise discipline. Call out revenge trades and overtrading kindly.');
  parts.push('15. POST-TRADE AUTOPSY mode: Be specific, honest, and reference Brain history patterns.');
  parts.push('16. SCENARIO mode: Give 3 clear scenarios with specific price levels and action steps.');
  parts.push('17. RE-ENTRY WINDOWS: If active re-entry window exists for the ticker, reference the trigger type and time left.');
  parts.push('18. BRAIN SUPPRESS: If Brain flags a ticker as unreliable (high miss rate), warn the user.');
  parts.push('19. HOT PATTERNS: If Brain has discovered hot patterns matching this setup, mention them.');
  parts.push('20. COLD STRATEGIES: If the strategy in question is in Brain cold rotation, warn the user.');
  parts.push('21. AUTOPSY REFERENCE: If recent autopsies show repeat mistakes on this ticker, call it out.');
  parts.push('22. SESSION WIN RATES: Reference the user\'s own session win rates when giving entry timing advice.');
  parts.push('23. VWAP: Always reference price vs VWAP when discussing entry. Above VWAP = calls bias, below = puts bias.');
  parts.push('24. HOLD WINDOW: Always give a specific hold window range (e.g. "5–20 min for SCALP") based on play type and DTE.');
  parts.push('25. 0DTE THETA CLIFF: Warn loudly if current time is past 1:30 PM CT on a 0DTE position.');
  parts.push('26. CURRENT TIME: You know the exact CT time from Layer 0. Use it — e.g. "It\'s 10:22 AM CT, morning session, prime window."');
  parts.push('27. GHOST COMPARISON: If Brain combos data shows Ghost outperforming on this setup, mention it as a calibration signal.');
  parts.push('28. PRE-MARKET: During pre-market, warn about thin liquidity and wide spreads on all contract recommendations.');
  parts.push('29. CANDLES: If last 5 candles show consecutive lower closes, mention bearish pressure regardless of longer-term signal.');
  parts.push('30. OPTIONS GREEKS: Reference delta, gamma, theta from the options snapshot when discussing premium decay or leverage.');
  parts.push('31. FOMC DAY MODE: If sessionContext mentions FOMC or there is an extreme macro event today, lead every trade entry question with: "FOMC day — are you past the freeze zone? Is your entry after the first move settled?"');
  parts.push('32. FOMC FREEZE ZONE: If adjustmentLabel contains "BLACKOUT" or "FREEZE" or minutesUntilDecision < 30 in macroIntel, say: "We are in FOMC blackout — no new entries. Protect open positions only."');
  parts.push('33. POST-FOMC FADE: In the 60 min after an FOMC decision, always warn: "First move after FOMC is almost always a fake-out. Do NOT chase. Wait 10-15 min for confirmed direction — then trade the continuation or fade."');
  parts.push('34. IV CRUSH: If FOMC or extreme macro event is < 120 min away and user has open options positions, say: "IV will collapse the moment the decision drops — even winning direction can lose money if you hold through. Consider closing or hedging."');
  parts.push('35. STRADDLE WINDOW: If FOMC is 90–30 min away, proactively suggest: "Classic straddle window — buy ATM SPY CALL + PUT same strike, same expiry. Exit both within 20 min of announcement. You profit from the volatility spike regardless of direction."');
  parts.push('36. GEOPOLITICAL RISK: If adjustmentLabel contains "GEO RISK" or geopoliticalRiskElevated is true, add: "Geopolitical risk is elevated today — tighten all stops 10%, avoid new swing positions, and watch energy/defense names (XOM, LMT, RTX)."');
  parts.push('37. LIVE DATA: You ALWAYS receive live market data injected into this context. NEVER tell the user "I don\'t have live data" or ask them to provide price, IV, or chart. If a specific ticker\'s data is missing, say: "I see you asked about [TICKER] — I\'m working with the data I have. Here\'s my read:" and proceed with your best professional analysis using macro, sector, and signal context.');
  parts.push('38. NEVER ASK THE USER TO PROVIDE DATA: Do not ask the user for their entry price, current price, IV rank, weekly open, or any market data. You are an AI with data access. Use it. If data is thin, say so briefly and still give analysis.');
  parts.push('39. MISSED TRADES AUTOPSY: When user asks "what did I miss?", "what did I leave on the table?", "session autopsy", "what signals did I skip?", or similar — use the SESSION SIGNAL AUTOPSY section above. List every skipped signal with its outcome and estimated option P&L, calculate the total missed gains, identify the single best setup they passed on. Be direct and specific. NEVER ask them questions or say you need more info.');

  return parts.filter(function(p) { return p !== undefined && p !== null; }).join('\n');
}
