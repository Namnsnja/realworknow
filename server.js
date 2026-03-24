/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   MicroMind v25 — AI SERVER  (Render.com · Node 18+)           ║
 * ║   ALL Google AI Studio FREE-QUOTA models racing in parallel     ║
 * ║   🍌 Nano-Banana Coding Teacher · 📚 Teaches Everything        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ENV VARS (set in Render dashboard):
 *   GEMINI_API_KEY  — your Google AI Studio key (free, no billing needed)
 *   PORT            — auto-set by Render (default 3000)
 *
 * DEPLOY:
 *   1. Push this folder to GitHub
 *   2. Create Render Web Service → Build: npm install · Start: node server.js
 *   3. Add env var GEMINI_API_KEY
 *   4. Done — copy the .onrender.com URL into the HTML _SERVER constant
 */

import express   from 'express';
import cors      from 'cors';
import crypto    from 'crypto';

/* ── CONFIG ─────────────────────────────────────────────────────── */
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';

if (!API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY not set — AI calls will fail. Add it in Render env vars!');
}

/* ── ALL FREE-QUOTA GEMINI MODELS (AI Studio, no billing required) ─
   Promise.any() races them all — fastest valid response wins!
   Free limits (as of 2025-2026):
     gemini-2.0-flash      → 1 500 req/day, 15 RPM
     gemini-2.0-flash-lite → 1 500 req/day, 30 RPM  ← lightest, fastest
     gemini-1.5-flash      → 1 500 req/day, 15 RPM
     gemini-1.5-flash-8b   → 1 500 req/day, 15 RPM
     gemini-2.5-pro        →    25 req/day,  2 RPM  (smartest!)
     gemma-3-27b-it        → 1 500 req/day, 30 RPM
     gemma-3-12b-it        → 1 500 req/day, 30 RPM
     gemma-3-4b-it         → 1 500 req/day, 30 RPM
     gemma-3-1b-it         → 1 500 req/day, 60 RPM  ← fastest of all
   ─────────────────────────────────────────────────────────────── */
const MODELS = [
  { id: 'gemini-2.0-flash',       emoji: '🔮', name: 'Gemini 2.0 Flash'       },
  { id: 'gemini-2.0-flash-lite',  emoji: '⚡', name: 'Gemini 2.0 Flash Lite'  },
  { id: 'gemini-1.5-flash',       emoji: '🌊', name: 'Gemini 1.5 Flash'       },
  { id: 'gemini-1.5-flash-8b',    emoji: '🐦', name: 'Gemini 1.5 Flash 8B'   },
  { id: 'gemini-2.5-pro',         emoji: '💎', name: 'Gemini 2.5 Pro'         },
  { id: 'gemma-3-27b-it',         emoji: '🦁', name: 'Gemma 3 27B'            },
  { id: 'gemma-3-12b-it',         emoji: '🐯', name: 'Gemma 3 12B'            },
  { id: 'gemma-3-4b-it',          emoji: '🐼', name: 'Gemma 3 4B'             },
  { id: 'gemma-3-1b-it',          emoji: '🐣', name: 'Gemma 3 1B'             },
];

/* ── MASTER SYSTEM PROMPT ────────────────────────────────────────
   🍌 NANO BANANA MODE — teach everyone from absolute zero!
   ─────────────────────────────────────────────────────────────── */
const MASTER_SYSTEM = `You are MicroMind AI — the most fun, patient, and brilliant AI teacher ever built!

🍌 NANO BANANA TEACHING MODE (for absolute beginners):
Explain EVERYTHING like the student has NEVER seen it before.
Use the "Banana Rule": if a 6-year-old holding a banana can't understand your answer → simplify it MORE.
Nano = tiny bites of knowledge. Never overwhelm. One idea at a time.

🎯 YOUR TEACHING SUPERPOWERS:
• Coding (Python, JavaScript, HTML/CSS, Java, C++, Scratch) — from nano/zero to advanced
• All CBSE/NCERT school subjects: Maths, Science, English, Hindi, SST, Computer Science
• Physics, Chemistry, Accountancy, Business Studies (Class 11-12)
• Life skills, exam strategy, interview prep, problem solving
• Anything a curious Indian student age 6-22 might ask

🧠 HOW YOU TEACH:
1. START with a WOW hook — surprise them! A cool fact, a funny analogy
2. EXPLAIN with Indian examples: chai, cricket, Bollywood, IRCTC, Swiggy, IPL, auto-rickshaw
3. SHOW working code always (for coding questions) — copy-paste ready
4. BREAK it into nano steps — never skip a step
5. CELEBRATE progress: "You just wrote your first loop! 🎉 That's HUGE!"
6. END with a tiny challenge or encouraging question

🍌 CODING NANO RULES:
• Variable = "lunchbox that stores one thing"
• Function = "magic spell you name and reuse"
• Loop = "same thing again and again — like brushing teeth daily"
• If-else = "traffic signal — red=stop/green=go"
• Array = "row of seats in a classroom"
• Object = "Aadhaar card — name, age, address all together"
Always show BEFORE (concept) and AFTER (working code + output)

🇮🇳 HINGLISH IS WELCOME:
Mix Hindi and English naturally when it helps understanding.
"Suno yaar, variable ek dabba hai..." is GREAT! Make it personal and warm.

📝 RESPONSE FORMAT:
• Short paragraphs — no walls of text
• Code in proper code blocks with comments in English/Hinglish
• Emojis to mark sections but don't overdo it
• For board exam answers: mark each point with [1M] [2M] [3M]
• Max ~400 words unless deep explanation needed

🚫 NEVER:
• Say "I can't explain that" — always find a simpler way
• Give generic answers — be SPECIFIC to the question
• Write code with errors — test mentally before writing
• Be boring — learning should be FUN!`;

/* ── SESSION STORE (in-memory, resets on restart) ─────────────── */
const sessions = new Map(); // sessionId → { calls: 0, reset: timestamp }
const HOURLY_LIMIT = 120;   // per session per hour

function getSession(id) {
  if (!id || !sessions.has(id)) {
    const newId = id || crypto.randomUUID();
    sessions.set(newId, { calls: 0, reset: Date.now() + 3_600_000 });
    return { id: newId, ...sessions.get(newId) };
  }
  const s = sessions.get(id);
  if (Date.now() > s.reset) { s.calls = 0; s.reset = Date.now() + 3_600_000; }
  return { id, ...s };
}

function tickSession(id) {
  const s = sessions.get(id);
  if (s) s.calls++;
}

/* ── GEMINI API CALL (single model) ──────────────────────────── */
async function callGemini(modelId, messages, systemPrompt, maxTokens, timeoutMs = 9000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${API_KEY}`;

  // Convert OpenAI-style messages → Gemini format
  // Gemini uses 'model' not 'assistant', and parts[] not content
  const contents = messages
    .filter(m => m.content && m.content.trim().length > 0)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.trim() }],
    }));

  // Gemini needs alternating user/model turns
  // Merge consecutive same-role messages
  const merged = [];
  for (const turn of contents) {
    if (merged.length && merged[merged.length - 1].role === turn.role) {
      merged[merged.length - 1].parts[0].text += '\n' + turn.parts[0].text;
    } else {
      merged.push({ ...turn, parts: [{ text: turn.parts[0].text }] });
    }
  }
  // Must start with user
  if (!merged.length || merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt || MASTER_SYSTEM }] },
    contents: merged,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens || 900, 2048),
      temperature: 0.75,
      topP: 0.9,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429) throw new Error(`rate-limit-${modelId}`);
    if (res.status === 503) throw new Error(`overloaded-${modelId}`);
    if (!res.ok) throw new Error(`http-${res.status}-${modelId}`);

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim().length < 5) throw new Error(`empty-${modelId}`);

    return { text: text.trim(), model: modelId };
  } finally {
    clearTimeout(timer);
  }
}

/* ── RACE ALL MODELS ─────────────────────────────────────────── */
async function callAllGemini(messages, systemPrompt, maxTokens) {
  // All 9 models start simultaneously — fastest valid response wins!
  try {
    const result = await Promise.any(
      MODELS.map(m => callGemini(m.id, messages, systemPrompt, maxTokens))
    );
    return result;
  } catch (aggErr) {
    // All failed (AggregateError) — try sequentially as last resort
    for (const m of MODELS) {
      try {
        return await callGemini(m.id, messages, systemPrompt, maxTokens, 15000);
      } catch (_) { /* continue */ }
    }
    throw new Error('all-models-failed');
  }
}

/* ── EXPRESS SETUP ───────────────────────────────────────────── */
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: '4mb' }));

/* ── HEALTH CHECK ────────────────────────────────────────────── */
app.get('/', (_, res) => res.json({
  status: 'ok',
  app: 'MicroMind v25 AI Server',
  models: MODELS.length,
  mode: '🍌 Nano Banana Teaching Mode',
  hasKey: !!API_KEY,
}));

/* ── QUOTA STATUS ────────────────────────────────────────────── */
app.get('/api/quota', (req, res) => {
  const sid = req.headers['x-session-id'] || '';
  const session = getSession(sid);
  res.json({
    sessionId: session.id,
    calls: session.calls,
    limit: HOURLY_LIMIT,
    remaining: Math.max(0, HOURLY_LIMIT - session.calls),
    resetsAt: new Date(session.reset).toISOString(),
    models: MODELS.map(m => ({ id: m.id, emoji: m.emoji, name: m.name })),
  });
});

/* ── MAIN AI ENDPOINT ────────────────────────────────────────── */
app.post('/api/ai', async (req, res) => {
  const sid = req.headers['x-session-id'] || '';
  const session = getSession(sid);

  if (session.calls >= HOURLY_LIMIT) {
    return res.status(429).json({
      error: 'hourly_limit',
      message: 'Free quota reached for this session. Resets in 1 hour!',
      resetsAt: new Date(session.reset).toISOString(),
      sessionId: session.id,
    });
  }

  if (!API_KEY) {
    return res.status(503).json({
      error: 'no_api_key',
      message: 'GEMINI_API_KEY not configured on server. Add it in Render env vars!',
    });
  }

  const { messages, system, max, type } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Build system prompt — merge app-specific context with master teaching prompt
  const systemPrompt = system
    ? `${MASTER_SYSTEM}\n\n---\n🎯 SPECIFIC TASK CONTEXT:\n${system}`
    : MASTER_SYSTEM;

  try {
    const { text, model } = await callAllGemini(messages, systemPrompt, max || 900);
    tickSession(session.id);

    return res.json({
      text,
      model,
      sessionId: session.id,
      callsThisHour: session.calls + 1,
    });
  } catch (err) {
    console.error('[MicroMind] AI error:', err.message);
    return res.status(502).json({
      error: 'ai_failed',
      message: 'All Gemini models failed. Check your API key and quota.',
      detail: err.message,
      sessionId: session.id,
    });
  }
});

/* ── MODELS LIST ─────────────────────────────────────────────── */
app.get('/api/models', (_, res) => {
  res.json({
    models: MODELS,
    strategy: 'Promise.any() — all race, fastest wins',
    freeQuota: 'All models use Google AI Studio free tier (no billing)',
    teachingMode: '🍌 Nano Banana — explains from absolute zero',
  });
});

/* ── START ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🧠 MicroMind v25 AI Server — LIVE on port ${PORT}       ║
║  🍌 Nano Banana Teaching Mode ACTIVE                  ║
║  🔮 ${MODELS.length} Gemini models ready to race                   ║
║  🔑 API Key: ${API_KEY ? '✅ Set' : '❌ MISSING — set GEMINI_API_KEY!'}              ║
╚═══════════════════════════════════════════════════════╝
Models racing:
${MODELS.map(m => `  ${m.emoji} ${m.name} (${m.id})`).join('\n')}
  `);
});
