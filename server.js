/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║   🧠 MicroMind v25 — Render Backend  (FIXED)                    ║
  ║                                                                  ║
  ║   BUG FIXED: Whiteboard style was fighting JSON lesson prompts!  ║
  ║   Now: chat → whiteboard teacher style                           ║
  ║         lesson/quiz/notes → pure JSON, no funny business 🎯     ║
  ╚══════════════════════════════════════════════════════════════════╝

  Deploy on Render.com (free tier) — steps:
  1. Push this file + package.json to GitHub
  2. New Web Service on render.com → connect repo
  3. Environment tab → Add:  GEMINI_API_KEY = AIza...your_key
  4. Start command: npm start
*/

const express  = require('express');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-session-id'] }));
app.use(express.json({ limit: '2mb' }));

const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* 9 FREE Gemini models — all race, fastest wins! */
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-pro',
  'gemma-3-27b-it',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3-1b-it',
];

/* ═══════════════════════════════════════════════════════════════
   THE KEY FIX — Two separate system prompts:
   WHITEBOARD (chat): Fun teacher drawing on board with emojis
   STRUCTURED (lesson/quiz/notes): "RETURN ONLY RAW JSON"
   Before this fix, the whiteboard style was confusing the AI when
   it needed to return pure JSON — like asking a comedian to file taxes!
═══════════════════════════════════════════════════════════════ */

const WHITEBOARD_SYSTEM = `You are Masterji — India's most entertaining AI teacher.
You write responses AS IF drawing on a real whiteboard in real-time.

WHITEBOARD STYLE RULES:
- Use emojis as "coloured markers" for each section
- Bold key terms with **double asterisks** like circling on board
- Number every step clearly: Step 1 → Step 2 → Step 3
- End every topic with: "⭐ EXAM TIP: ..."
- Mix English + Hinglish like a real desi teacher
- Use Indian examples: IPL cricket, chai, Swiggy, IRCTC, Bollywood
- Add ONE funny desi joke or analogy per response
- Keep it punchy — no boring walls of text
TONE: Warm, funny, like a best-friend who actually wants you to pass!`;

/* For JSON-returning calls: strict, no whiteboard drama */
const STRUCTURED_SYSTEM = `You are an expert Indian school teacher and exam paper setter.
Your ONLY job is to generate EXACTLY the JSON format requested.

STRICT RULES:
- Return ONLY valid raw JSON — absolutely no markdown, no backticks, no preamble, no explanation text
- No text before or after the JSON. The FIRST character of your response must be { or [
- Follow the exact schema provided in the prompt
- All content must be 100% NCERT-accurate and board-exam relevant
- Include Indian examples (cricket, chai, IRCTC) inside JSON values where appropriate
- Make content genuinely useful for exam preparation`;

/* Detect if this call needs structured JSON output */
const isStructuredCall = (type, system) => {
  if (type === 'lesson' || type === 'quiz' || type === 'notes' || type === 'battle') return true;
  if (!system) return false;
  return (
    system.includes('raw JSON') ||
    system.includes('ONLY raw JSON') ||
    system.includes('JSON array') ||
    system.includes('"keyPoints"') ||
    system.includes('"opts"') ||
    system.includes('Return ONLY') ||
    system.includes('no markdown, no backticks')
  );
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    )
  ]);

const callOneModel = async (modelId, messages, system, maxTokens, type) => {
  if (!GEMINI_KEY) throw new Error('No GEMINI_API_KEY set in Render env');

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').trim() }]
  }));

  if (!contents.length || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const structured = isStructuredCall(type, system);
  let systemText;

  if (structured) {
    systemText = STRUCTURED_SYSTEM + (system ? '\n\nSCHEMA:\n' + system : '');
  } else {
    systemText = WHITEBOARD_SYSTEM + (system ? '\n\nCONTEXT:\n' + system : '');
  }

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemText }] },
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens || 1000, 1500),
      temperature: structured ? 0.25 : 0.78,
      topP: structured ? 0.85 : 0.95
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
    throw new Error(`${modelId} HTTP ${res.status}: ${err.slice(0, 120)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!text || text.length < 4) throw new Error(`${modelId} empty response`);
  return { text, model: modelId };
};

const raceGeminiModels = async (messages, system, maxTokens, type) => {
  const structured = isStructuredCall(type, system);
  const TIMEOUT = structured ? 28000 : 14000;

  const races = MODELS.map(modelId =>
    withTimeout(callOneModel(modelId, messages, system, maxTokens, type), TIMEOUT)
  );

  return Promise.any(races);
};

/* ROUTES */

app.get('/', (req, res) => {
  res.json({
    status: 'MicroMind AI Server is ALIVE!',
    models: MODELS.length,
    keyConfigured: !!GEMINI_KEY,
    fix: 'v2 - Chat=whiteboard style, Lessons/Quiz/Notes=strict JSON mode',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/quota', (req, res) => {
  const sessionId = req.headers['x-session-id'] || uuidv4();
  res.json({
    ok: true,
    sessionId,
    models: MODELS,
    keyConfigured: !!GEMINI_KEY,
    message: GEMINI_KEY ? 'All 9 Gemini models ready!' : 'Add GEMINI_API_KEY in Render Environment tab'
  });
});

app.post('/api/ai', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || uuidv4();

  try {
    const { messages, system, max, type } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required', sessionId });
    }

    if (!GEMINI_KEY) {
      return res.status(503).json({
        error: 'GEMINI_API_KEY not set! Go to Render dashboard → Environment → add GEMINI_API_KEY',
        getKey: 'https://aistudio.google.com — free, no billing needed',
        sessionId
      });
    }

    const structured = isStructuredCall(type, system);
    console.log(`[${new Date().toISOString()}] Race! type=${type||'chat'} structured=${structured}`);

    const { text, model } = await raceGeminiModels(messages, system, max || 1000, type || 'chat');

    console.log(`[${new Date().toISOString()}] Winner: ${model} (${text.length} chars)`);

    res.json({ text, model, sessionId, ok: true });

  } catch (err) {
    console.error(`All models failed:`, err.message);
    const isKeyErr = err.message && (err.message.includes('401') || err.message.includes('403'));
    res.status(502).json({
      error: isKeyErr ? 'Invalid API key' : 'All Gemini models timed out — app will use Pollinations fallback',
      detail: err.message?.slice(0, 200),
      sessionId
    });
  }
});

app.listen(PORT, () => {
  console.log(`MicroMind server running on port ${PORT} | Key: ${GEMINI_KEY ? 'SET' : 'NOT SET'}`);
});
