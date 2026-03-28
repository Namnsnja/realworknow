/*
 ╔══════════════════════════════════════════════════════════════╗
 ║   MicroMind AI Server v2 — Fixed for Render.com             ║
 ║   Races ALL 9 FREE Gemini models — fastest one wins!        ║
 ╚══════════════════════════════════════════════════════════════╝
*/

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';   // CRITICAL: must be 0.0.0.0 for Render port detection
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

/* Keep-alive ping */
app.get('/ping', (req, res) => res.send('pong'));

/* All 9 FREE Gemini models */
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-pro-exp-03-25',
  'gemma-3-27b-it',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3-1b-it',
];

async function callGemini(modelId, messages, system, maxTokens) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').trim() }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${modelId} HTTP ${res.status}: ${err?.error?.message || 'error'}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim().length < 4) throw new Error(`${modelId}: empty response`);
    return { text: text.trim(), model: modelId };

  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function normalizeMessages(messages) {
  let out = messages
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').trim() }))
    .filter(m => m.content.length > 0);

  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: 'Hello' });

  const merged = [];
  for (const m of out) {
    if (merged.length && merged[merged.length - 1].role === m.role)
      merged[merged.length - 1].content += '\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

/* POST /api/ai — Race 9 models, return fastest */
app.post('/api/ai', async (req, res) => {
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });
  }

  const { messages, system, max } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const norm   = normalizeMessages(messages);
  const maxTok = Math.min(Number(max) || 1200, 1500);

  console.log(`[AI] "${norm[norm.length-1]?.content?.slice(0,60)}..."`);

  const racers = MODELS.map(id => callGemini(id, norm, system || null, maxTok));

  try {
    const winner = await Promise.any(racers);
    console.log(`[AI] Winner: ${winner.model}`);
    res.json({ text: winner.text, model: winner.model, ok: true });
  } catch (aggErr) {
    const details = aggErr?.errors?.map(e => e.message) || [aggErr.message];
    console.error('[AI] All failed:', details);
    res.status(503).json({ error: 'All Gemini models failed', details });
  }
});

/* Root page */
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center">
    <h1>🔮 MicroMind AI Server</h1>
    <p style="color:green;font-size:18px"><b>✅ Running on port ${PORT}</b></p>
    <p>Models: <b>${MODELS.length} Gemini models racing</b></p>
    <p>Key: <b style="color:${GEMINI_KEY?'green':'red'}">${GEMINI_KEY?'✅ Set!':'❌ Add GEMINI_API_KEY env var!'}</b></p>
  </body></html>`);
});

/* MUST bind to 0.0.0.0 — Render scans for open ports on this host */
app.listen(PORT, HOST, () => {
  console.log(`\n🚀 MicroMind server live on ${HOST}:${PORT}`);
  console.log(`🎯 ${MODELS.length} Gemini models ready to race`);
  console.log(`🔑 API Key: ${GEMINI_KEY ? '✅ Set' : '❌ NOT SET — add GEMINI_API_KEY in Render!'}\n`);
});
