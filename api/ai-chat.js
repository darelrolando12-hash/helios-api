module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  const { messages, context } = req.body ?? {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompt = buildSystemPrompt(context ?? {});
  const isDeepAnalysis = !!(context && context.systemOverride);
  const maxTokens = isDeepAnalysis ? 800 : 350;
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
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[ai-chat] Anthropic error:', response.status, errText);
      const isAuthError = response.status === 401;
      const isOverloaded = response.status === 529 || response.status === 503;
      const msg = isAuthError
        ? 'AI not configured. Check ANTHROPIC_API_KEY in Vercel environment variables.'
        : isOverloaded
        ? 'AI service is busy. Try again in a moment.'
        : 'AI service error: ' + response.status + ' — ' + errText.slice(0, 120);
      return res.status(500).json({ error: msg });
    }

    const data = await response.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    if (!rawText) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    const intent = parseIntent(rawText, messages);
    if (intent) {
      return res.status(200).json({
        type: 'function',
        functionName: intent.name,
        functionArgs: intent.args,
        text: null,
      });
    }

    return res.status(200).json({ type: 'text', text: rawText, functionName: null, functionArgs: null });

  } catch (err) {
    console.error('[ai-chat] error:', err);
    return res.status(500).json({ error: 'AI unavailable. Check your connection.' });
  }
};

function normalizeMessages(messages) {
  const filtered = messages.filter(function(m) { return m.role === 'user' || m.role === 'assistant'; });
  if (filtered.length === 0) return [];
  var result = [];
  for (var i = 0; i < filtered.length; i++) {
    var msg = filtered[i];
    var last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  if (result[0] && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: 'Hello' });
  }
  return result.slice(-10);
}

function parseIntent(aiReply, messages) {
  var reversed = messages.slice().reverse();
  var lastUserMsg = reversed.find(function(m) { return m.role === 'user'; });
  var lastUser = (lastUserMsg && lastUserMsg.content) ? lastUserMsg.content.toLowerCase() : '';

  var navMap = {
    dashboard:  ['dashboard', 'home', 'overview'],
    scanner:    ['scanner', 'scan', 'intraday'],
    signals:    ['signals', 'signal feed', 'elite plays'],
    journal:    ['journal', "i'm in", 'trades', 'paper trade'],
    options:    ['options', 'options chain', 'chain'],
    chart:      ['chart scan', 'chart', 'chart analysis'],
    brain:      ['brain', 'helios brain', 'ghost'],
    settings:   ['settings', 'preferences'],
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
  if (watchMatch) {
    return { name: 'add_watchlist', args: { ticker: watchMatch[1].toUpperCase() } };
  }

  var alertMatch = lastUser.match(/(?:set|create|add)\s+(?:an?\s+)?alert\s+(?:for\s+)?([A-Z]{1,5})\s+(?:at|when|if)?\s*\$?([\d.]+)/i);
  if (alertMatch) {
    var dir = (lastUser.includes('below') || lastUser.includes('drops')) ? 'below' : 'above';
    return { name: 'set_alert', args: { ticker: alertMatch[1].toUpperCase(), price: parseFloat(alertMatch[2]), direction: dir } };
  }

  return null;
}

function buildSystemPrompt(context) {
  var {
    session, marketBias, activeTrades, bestContracts,
    brainStats, watchlist, accountSize, riskTolerance,
    tradeHistory, topSignals,
  } = context;

  var tradesDetail = (activeTrades && activeTrades.length)
    ? activeTrades.map(function(t) {
        return t.symbol + ' ' + t.direction.toUpperCase() +
          ' $' + t.strike + ' exp ' + t.expiry +
          ' | entry $' + t.entryPremium.toFixed(2) +
          ' | now $' + t.currentPremium.toFixed(2) +
          ' | P&L ' + (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(1) + '%' +
          ' | held ' + t.minutesHeld + 'm';
      }).join('\n')
    : 'No active trades';

  var contractsDetail = (bestContracts && bestContracts.length)
    ? bestContracts.slice(0, 3).map(function(c) {
        return c.symbol + ' ' + c.direction.toUpperCase() +
          ' $' + c.strike + ' exp ' + c.expiry +
          ' | score ' + c.engineScore +
          ' | premium $' + c.premium.toFixed(2);
      }).join('\n')
    : 'No contracts loaded';

  var brainDetail = brainStats
    ? 'Win rate: ' + brainStats.winRate + '% | Elite rate: ' + brainStats.eliteRate + '% | Total trades: ' + brainStats.totalTrades
    : 'Brain not loaded';

  var profileDetail = accountSize
    ? 'Account: $' + Number(accountSize).toLocaleString() + ', risk: ' + (riskTolerance || 'moderate')
    : 'No account size set';

  var historyDetail = tradeHistory
    ? 'Personal history: ' + tradeHistory.winRate + '% win rate across ' + tradeHistory.totalTrades + ' trades, avg gain ' + tradeHistory.avgGain + '%'
    : 'No trade history yet';

  var signalsDetail = (topSignals && topSignals.length)
    ? topSignals.slice(0, 3).map(function(s) {
        var age = s.ageMinutes !== undefined ? ' (' + s.ageMinutes + 'm old)' : '';
        return s.symbol + ' ' + s.signal.toUpperCase() + ' (' + s.conviction + '% conviction' + age + ')';
      }).join(', ')
    : 'no fresh signals';

  var watchlistStr = (watchlist && watchlist.length) ? watchlist.join(', ') : 'empty';
  var signalsLine = (topSignals && topSignals.length) ? '- Top signals: ' + signalsDetail : '';

  return 'You are Helios, an elite AI trading assistant inside the Helios options analysis platform.\n' +
    'Personality: Confident, sharp, direct. You sound like an experienced trader, not a financial advisor. Never hype, never guarantee results.\n' +
    'Always frame things as analysis and education, never as financial advice.\n\n' +
    'LIVE MARKET CONTEXT:\n' +
    '- Session: ' + session + ' CT\n' +
    '- Market bias: ' + (marketBias || 'checking...') + '\n' +
    '- Watchlist: ' + watchlistStr + '\n' +
    signalsLine + '\n\n' +
    'ACTIVE TRADES (REAL-TIME):\n' + tradesDetail + '\n\n' +
    'BEST CONTRACTS NOW:\n' + contractsDetail + '\n\n' +
    'GHOST BRAIN INTELLIGENCE:\n' + brainDetail + '\n\n' +
    'USER PROFILE:\n' + profileDetail + '\n' + historyDetail + '\n\n' +
    'CRITICAL RULES:\n' +
    '1. Keep responses SHORT — under 3 sentences for voice. Never ramble.\n' +
    '2. When user asks "should I exit [ticker]?" check active trade P&L and give a data-driven answer.\n' +
    '3. When user asks "what should I trade?" reference best contracts with actual scores.\n' +
    '4. If user asks about entry timing, check session (avoid entries after 14:00 CT) and signal freshness.\n' +
    '5. NEVER make up data. Use the context above or say "let me check the scanner".\n' +
    '6. Always mention risk when discussing trades.\n' +
    '7. Speak naturally — this is voice, not chat. Use contractions, be human.\n' +
    '8. If data is stale, tell user to refresh the scanner first.\n' +
    '9. When signal age is over 30 minutes, warn: "That signal is a bit old, double-check the chart before entry."';
}
