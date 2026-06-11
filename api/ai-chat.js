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
  const isDeepAnalysis = !!(context?.systemOverride);
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
        model: 'claude-3-haiku-20240307',
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
        : 'AI service error. Please try again.';
      return res.status(500).json({ error: msg });
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text ?? '';
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
  const filtered = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (filtered.length === 0) return [];
  const result = [];
  for (const msg of filtered) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  if (result[0]?.role !== 'user') {
    result.unshift({ role: 'user', content: 'Hello' });
  }
  return result.slice(-10);
}

function parseIntent(aiReply, messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content?.toLowerCase() ?? '';

  const navMap = {
    dashboard:  ['dashboard', 'home', 'overview'],
    scanner:    ['scanner', 'scan', 'intraday'],
    signals:    ['signals', 'signal feed', 'elite plays'],
    journal:    ['journal', "i'm in", 'trades', 'paper trade'],
    options:    ['options', 'options chain', 'chain'],
    chart:      ['chart scan', 'chart', 'chart analysis'],
    brain:      ['brain', 'helios brain', 'ghost'],
    settings:   ['settings', 'preferences'],
  };

  for (const [page, keywords] of Object.entries(navMap)) {
    if (keywords.some(k => lastUser.includes(k) && (
      lastUser.includes('go to') || lastUser.includes('open') ||
      lastUser.includes('show me') || lastUser.includes('take me') ||
      lastUser.includes('navigate')
    ))) {
      const tickerMatch = lastUser.match(/\b([A-Z]{2,5})\b/);
      return { name: 'navigate', args: { page, ticker: tickerMatch?.[1] } };
    }
  }

  const watchMatch = lastUser.match(/add\s+([A-Z]{1,5})\s+to\s+(?:my\s+)?watchlist/i);
  if (watchMatch) {
    return { name: 'add_watchlist', args: { ticker: watchMatch[1].toUpperCase() } };
  }

  const alertMatch = lastUser.match(/(?:set|create|add)\s+(?:an?\s+)?alert\s+(?:for\s+)?([A-Z]{1,5})\s+(?:at|when|if)?\s*\$?([\d.]+)/i);
  if (alertMatch) {
    const dir = lastUser.includes('below') || lastUser.includes('drops') ? 'below' : 'above';
    return { name: 'set_alert', args: { ticker: alertMatch[1].toUpperCase(), price: parseFloat(alertMatch[2]), direction: dir } };
  }

  if (/best contracts?|top picks?|what should i trade|show.{0,10}picks/i.test(lastUser)) {
    return { name: 'show_best_contracts', args: {} };
  }

  if (/market bias|market overview|how.{0,10}market|market direction/i.test(lastUser)) {
    return { name: 'show_market_bias', args: {} };
  }

  const analyzeMatch = lastUser.match(/(?:analyze|analysis|tell me about|check|look at)\s+([A-Z]{1,5})\b/i);
  if (analyzeMatch) {
    return { name: 'analyze_ticker', args: { ticker: analyzeMatch[1].toUpperCase(), focus: 'full' } };
  }

  return null;
}

function buildSystemPrompt(context) {
  const {
    marketBias, topSignals, activeTrades, watchlist, bestContracts,
    ghostStats, accountSize, riskTolerance, tradeHistory, time,
    systemOverride,
  } = context;

  if (systemOverride) return systemOverride;

  const now = time ? new Date(time) : new Date();
  const ctHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getHours();
  const session =
    ctHour < 8.5  ? 'Pre-Market' :
    ctHour < 9.5  ? 'Market Open' :
    ctHour < 12   ? 'Morning' :
    ctHour < 14   ? 'Afternoon' :
    ctHour < 15   ? 'Power Hour' : 'After Hours';

  const tradesDetail = activeTrades?.length
    ? activeTrades.map(t =>
        `${t.symbol} ${t.direction} (${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%, ${t.exitTiersHit ?? 0} exits hit)`
      ).join(', ')
    : 'none';

  const contractsDetail = bestContracts?.length
    ? bestContracts.slice(0, 2).map(c =>
        `${c.symbol} ${c.direction.toUpperCase()} (${c.score}% score, est. +${c.estimatedGainPct}%)`
      ).join(', ')
    : 'none available';

  const brainDetail = ghostStats
    ? `Ghost accuracy: ${ghostStats.overallAccuracy}% overall, ${ghostStats.sessionAccuracy}% today${ghostStats.topTicker ? `. Best on ${ghostStats.topTicker.symbol} (${ghostStats.topTicker.winRate}% win rate)` : ''}`
    : 'Ghost data loading';

  const profileDetail = accountSize
    ? `Account: $${accountSize.toLocaleString()}, risk: ${riskTolerance ?? 'moderate'}`
    : 'No account size set';

  const historyDetail = tradeHistory
    ? `Personal history: ${tradeHistory.winRate}% win rate across ${tradeHistory.totalTrades} trades, avg gain ${tradeHistory.avgGain}%`
    : 'No trade history yet';

  const signalsDetail = topSignals?.length
    ? topSignals.slice(0, 3).map(s => {
        const age = s.ageMinutes !== undefined ? `(${s.ageMinutes}m old)` : '';
        return `${s.symbol} ${s.signal.toUpperCase()} (${s.conviction}% conviction${age})`;
      }).join(', ')
    : 'no fresh signals';

  return `You are Helios, an elite AI trading assistant inside the Helios options analysis platform.
Personality: Confident, sharp, direct. You sound like an experienced trader — not a financial advisor. Never hype, never guarantee results.
Always frame things as analysis and education, never as financial advice.

LIVE MARKET CONTEXT:
- Session: ${session} CT
- Market bias: ${marketBias ?? 'checking...'}
- Watchlist: ${watchlist?.join(', ') ?? 'empty'}
${topSignals?.length ? `- Top signals: ${signalsDetail}` : ''}

ACTIVE TRADES (REAL-TIME):
${tradesDetail}

BEST CONTRACTS NOW:
${contractsDetail}

GHOST BRAIN INTELLIGENCE:
${brainDetail}

USER PROFILE:
${profileDetail}
${historyDetail}

CRITICAL RULES:
1. Keep responses SHORT — under 3 sentences for voice. Never ramble.
2. When user asks "should I exit [ticker]?" → check active trade P&L + Ghost accuracy, give a data-driven answer.
3. When user asks "what should I trade?" → reference best contracts with actual scores.
4. If user asks about entry timing → check session (avoid entries after 14:00 CT) and signal freshness.
5. NEVER make up data. Use the context above or say "let me check the scanner".
6. Always mention risk when discussing trades.
7. Speak naturally — this is voice, not chat. Use contractions, be human.
8. If data is stale → tell user to refresh the scanner first.
9. When signal age is over 30 minutes, warn: "That signal is a bit old, double-check the chart before entry."`;
}
