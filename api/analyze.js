module.exports = async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, mediaType, context } = req.body;
  if (!image || !mediaType) return res.status(400).json({ error: 'Missing image or mediaType' });

  const prompt = `You are a professional technical analyst. Analyze this chart screenshot and return ONLY a valid JSON object with these exact fields:
{
  "bullCase": "string — bull case / reasons to buy calls",
  "bearCase": "string — bear case / reasons to buy puts",
  "keyLevels": ["array", "of", "price level strings"],
  "risks": ["array", "of", "risk strings"],
  "summary": "string — balanced summary"
}

${context ? `CONTEXT:\n${context}` : ''}

Return ONLY the JSON. No markdown, no explanation.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: prompt }
        ],
      }],
    }),
  });

  const data = await response.json();
  const text = data?.content?.[0]?.text || '{}';
  res.status(200).send(text);
};
