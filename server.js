/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║   🧠 MicroMind v25 — Render Backend                             ║
  ║   9 Gemini models race like Usain Bolt — fastest wins! 🏃‍♂️💨    ║
  ║                                                                  ║
  ║   Deploy on Render.com (free tier) — zero cost, full power!     ║
  ║   Set env var:  GEMINI_API_KEY = your Google AI Studio key       ║
  ╚══════════════════════════════════════════════════════════════════╝
*/

const express  = require('express');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── CORS — let ANY origin call us (it's a free education app!) ── */
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-session-id'] }));
app.use(express.json({ limit: '2mb' }));

/* ── Your Google AI Studio API key (FREE, no billing needed!) ─────
   1. Go to https://aistudio.google.com
   2. Click "Get API Key" → Create key → Copy it
   3. In Render dashboard → Environment → Add:
      Key: GEMINI_API_KEY   Value: AIza...your...key
   ──────────────────────────────────────────────────────────────── */
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

/* ── THE RACING TEAM — 9 FREE Gemini models (fastest one wins!) ─── */
const MODELS = [
  'gemini-2.0-flash',         // 🔮 The Usain Bolt of AI — incredibly fast
  'gemini-2.0-flash-lite',    // ⚡ Even lighter — for slow networks
  'gemini-1.5-flash',         // 🌊 Battle-tested veteran
  'gemini-1.5-flash-8b',      // 🐦 Compact & never gives up
  'gemini-2.5-pro',           // 💎 The Einstein — smartest but slowest
  'gemma-3-27b-it',           // 🦁 Open-source heavyweight champion
  'gemma-3-12b-it',           // 🐯 Mid-size and mighty
  'gemma-3-4b-it',            // 🐼 Small but surprisingly smart
  'gemma-3-1b-it',            // 🐣 Tiny Titan — last resort hero
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* ══════════════════════════════════════════════════════════════════
   🎬  WHITEBOARD SYSTEM PROMPT — Makes AI write like a real teacher
   drawing on a board: big headings, coloured markers, diagrams etc.
══════════════════════════════════════════════════════════════════ */
const WHITEBOARD_PREFIX = `
You are Masterji — India's most entertaining AI teacher 🧑‍🏫
You write responses AS IF drawing on a whiteboard in real-time.

📌 WHITEBOARD STYLE RULES:
━━━━━━━━━━━━━━━━━━━━━━━━━━
✏️  Use emojis as "coloured markers" — each section gets one
📌  Bold key terms like a teacher circling them on board
📐  Show formulas inside boxes:  ┌─────────────┐
                                  │  F = m × a  │
                                  └─────────────┘
🔢  Number every step clearly (Step 1→ Step 2→ Step 3→)
🎯  End every topic with:  "⭐ EXAM TIP: ..."
🗣️  Mix English + Hinglish (Hindi-English) like a real desi teacher
🇮🇳  Use Indian examples: IPL cricket, chai, Swiggy, IRCTC, Bollywood
🤣  Add ONE funny joke or desi analogy per lesson — make them laugh!
✅  Keep responses punchy — no boring walls of text

TONE: Warm, funny, like a best-friend tutor who actually WANTS you to pass.
`;

/* ── Timeout wrapper — don't wait forever for slow models ── */
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`⏰ timeout after ${ms}ms`)), ms)
    )
  ]);

/* ── Call one Gemini model — returns the response text ── */
const callOneModel = async (modelId, messages, system, maxTokens) => {
  if (!GEMINI_KEY) throw new Error('No API key configured — set GEMINI_API_KEY in Render env!');

  /* Build Gemini-style contents array */
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').trim() }]
  }));

  /* Ensure first message is from user (Gemini requirement) */
  if (!contents.length || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  /* Combine whiteboard prefix + caller's system prompt */
  const systemText = WHITEBOARD_PREFIX + (system ? '\n\nADDITIONAL CONTEXT:\n' + system : '');

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemText }] },
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens || 1000, 1500),
      temperature: 0.78,
      topP: 0.95
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  const url = `${GEMINI_BASE}/${modelId}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`${modelId} → HTTP ${res.status}: ${err.slice(0, 120)}`);
  }

  const data = await res.json();

  /* Extract text — Gemini puts it here */
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!text || text.length < 4) {
    throw new Error(`${modelId} returned empty response`);
  }
  return { text, model: modelId };
};

/* ══════════════════════════════════════════════════════════════════
   🏁  THE RACE — all 9 models sprint, fastest correct answer wins!
   Promise.any() = "run all at once, return first success"
   It's like 9 delivery boys on 9 bikes — first one with the food wins! 🛵
══════════════════════════════════════════════════════════════════ */
const raceGeminiModels = async (messages, system, maxTokens, type) => {
  const TIMEOUT = type === 'lesson' ? 22000 : 14000; // lessons get more time

  const races = MODELS.map(modelId =>
    withTimeout(callOneModel(modelId, messages, system, maxTokens), TIMEOUT)
  );

  /* Promise.any = return first that RESOLVES (not rejects) */
  const winner = await Promise.any(races);
  return winner;
};

/* ══════════════════════════════════════════════════════════════════
   🛣️  ROUTES
══════════════════════════════════════════════════════════════════ */

/* Health check — Render needs this to confirm the server is alive */
app.get('/', (req, res) => {
  res.json({
    status: '🧠 MicroMind AI Server is ALIVE and racing! 🏁',
    models: MODELS.length,
    message: 'Send POST /api/ai with {messages, system, max, type}',
    keyConfigured: !!GEMINI_KEY,
    timestamp: new Date().toISOString()
  });
});

/* Quota/session check — frontend pings this on load */
app.get('/api/quota', (req, res) => {
  const sessionId = req.headers['x-session-id'] || uuidv4();
  res.json({
    ok: true,
    sessionId,
    models: MODELS,
    keyConfigured: !!GEMINI_KEY,
    message: GEMINI_KEY ? '✅ All 9 Gemini models ready to race!' : '❌ Set GEMINI_API_KEY in Render env'
  });
});

/* ── 🏆 THE MAIN AI ENDPOINT ── */
app.post('/api/ai', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || uuidv4();

  try {
    const { messages, system, max, type } = req.body;

    /* Validate */
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required', sessionId });
    }

    if (!GEMINI_KEY) {
      return res.status(503).json({
        error: '❌ GEMINI_API_KEY not set! Go to Render dashboard → Environment and add your Google AI Studio key.',
        howToFix: 'Visit https://aistudio.google.com → Get API Key → Add to Render env as GEMINI_API_KEY',
        sessionId
      });
    }

    console.log(`[${new Date().toISOString()}] 🏁 Race starting! type=${type||'chat'} msgs=${messages.length}`);

    /* 🏁 START THE RACE! */
    const { text, model } = await raceGeminiModels(
      messages,
      system,
      max || 1000,
      type || 'chat'
    );

    console.log(`[${new Date().toISOString()}] 🏆 Winner: ${model} (${text.length} chars)`);

    res.json({ text, model, sessionId, ok: true });

  } catch (err) {
    /* All 9 models failed — this is very rare but handle it gracefully */
    console.error(`[${new Date().toISOString()}] ❌ All models failed:`, err.message || err);

    /* Check if it's likely an API key problem */
    const isKeyError = err.message && (
      err.message.includes('API_KEY') ||
      err.message.includes('401') ||
      err.message.includes('403')
    );

    res.status(502).json({
      error: isKeyError
        ? '❌ Invalid API key — check your GEMINI_API_KEY in Render env'
        : '❌ All 9 Gemini models timed out or failed. App will use Pollinations backup!',
      detail: err.message?.slice(0, 200),
      sessionId
    });
  }
});

/* ── Start server ── */
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🧠 MicroMind AI Server  — PORT ${PORT}               ║
║   9 Gemini models ready to RACE! 🏁                  ║
║   API Key: ${GEMINI_KEY ? '✅ Configured (' + GEMINI_KEY.slice(0,8) + '...)' : '❌ NOT SET — add GEMINI_API_KEY'}  ║
╚══════════════════════════════════════════════════════╝
  `);
});
