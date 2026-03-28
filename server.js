/* ═══════════════════════════════════════════════════════════════════
   🔮 MicroMind v27 — Render Server
   Races all 9 FREE Gemini models simultaneously — fastest reply wins!

   SETUP:
   1. npm install
   2. Set env var:  GEMINI_API_KEY=AIza...   (free from aistudio.google.com)
   3. node server.js   (or deploy to Render free tier)
   ════════════════════════════════════════════════════════════════ */

const express  = require('express');
const cors     = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

/* ── 9 FREE-QUOTA GEMINI MODELS ── */
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-pro-preview-05-06',
  'gemma-3-27b-it',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3-1b-it',
];

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('❌  GEMINI_API_KEY env var not set!'); }

/* ── Call one Gemini model ── */
async function callGemini(model, messages, system, maxTokens) {
  const timeout = model.includes('2.5-pro') ? 25000 : 15000; // 2.5 Pro is slower

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    /* Convert messages to Gemini format */
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').trim() }]
    })).filter(m => m.parts[0].text);

    /* Ensure first message is user */
    if (!contents.length || contents[0].role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(maxTokens || 1000, 2048),
        temperature: 0.7,
      }
    };

    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${model}: ${res.status} ${err?.error?.message || ''}`);
    }

    const data = await res.json();

    if (data.error) throw new Error(`${model}: ${data.error.message}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim().length < 5) throw new Error(`${model}: empty response`);

    return { text: text.trim(), model };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── /api/ai — race all 9 models ── */
app.post('/api/ai', async (req, res) => {
  const { messages, system, max, type } = req.body;

  if (!KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured on server.' });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    /* Race all 9 models — whoever answers first wins! */
    const { text, model } = await Promise.any(
      GEMINI_MODELS.map(m => callGemini(m, messages, system, max || 1200))
    );

    console.log(`✅ Winner: ${model} (${text.length} chars)`);
    res.json({ text, model, ok: true });
  } catch (err) {
    /* All 9 failed — that's rough */
    console.error('❌ All Gemini models failed:', err?.errors?.map?.(e => e.message));
    res.status(503).json({ error: 'All Gemini models failed. Check API key and quota.' });
  }
});

/* ── /api/quota — health check ── */
app.get('/api/quota', (req, res) => {
  res.json({
    status: 'ok',
    models: GEMINI_MODELS.length,
    hasKey: !!KEY,
    message: KEY ? '🔮 Gemini server running!' : '⚠️ GEMINI_API_KEY not set'
  });
});

/* ── Root ── */
app.get('/', (req, res) => {
  res.send(`
    <h2>🔮 MicroMind AI Server v25</h2>
    <p>Racing ${GEMINI_MODELS.length} Gemini models for fastest answers!</p>
    <p>Status: ${KEY ? '✅ API Key configured' : '❌ GEMINI_API_KEY missing'}</p>
    <p><a href="/api/quota">Check quota →</a></p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 MicroMind server live on port ${PORT}`);
  console.log(`🔮 ${GEMINI_MODELS.length} Gemini models ready to race`);
  console.log(`🔑 API Key: ${KEY ? '✅ Set' : '❌ MISSING — set GEMINI_API_KEY env var!'}\n`);
});
