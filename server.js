/* ═══════════════════════════════════════════════════════════════════════
   🧠  MicroMind v25 — Server
   ─────────────────────────────────────────────────────────────────────
   ✅ DUAL Gemini API key rotation — free quota NEVER runs out!
   ✅ 9 Gemini models race — fastest always wins
   ✅ /api/ai      → General chat (tutor mode)
   ✅ /api/lesson  → Generate full lesson (Nano Banana style)
   ✅ /api/notes   → Generate smart revision notes
   ✅ /api/whiteboard → Solve doubt like a teacher on a whiteboard
   ✅ /api/quiz    → Generate MCQ quiz
   ✅ /api/quota   → Session & quota info
   ─────────────────────────────────────────────────────────────────────
   ENV VARS  (set in Render Dashboard → Environment):
     GEMINI_API_KEY_1   → Your PRIMARY   Google AI Studio key
     GEMINI_API_KEY_2   → Your SECONDARY Google AI Studio key
     PORT               → (optional, Render sets this automatically)
   ═══════════════════════════════════════════════════════════════════════ */

import express      from 'express';
import cors         from 'cors';
import fetch        from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import rateLimit    from 'express-rate-limit';
import 'dotenv/config';

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── DUAL API KEY CONFIG ───────────────────────────────────────────── */
const KEY1 = process.env.GEMINI_API_KEY_1 || '';
const KEY2 = process.env.GEMINI_API_KEY_2 || '';

if (!KEY1 && !KEY2) {
  console.error('❌  NO API KEYS FOUND! Set GEMINI_API_KEY_1 and GEMINI_API_KEY_2 in Render env vars.');
}

/*  Key state tracker — tracks quota exhaustion per key  */
const keyState = {
  k1: { key: KEY1, exhausted: false, resetAt: 0, calls: 0, label: 'KEY1' },
  k2: { key: KEY2, exhausted: false, resetAt: 0, calls: 0, label: 'KEY2' },
};

/* Automatically un-exhaust a key after 60 seconds */
const checkReset = (ks) => {
  if (ks.exhausted && Date.now() > ks.resetAt) {
    ks.exhausted = false;
    console.log(`♻️  ${ks.label} quota reset — back in rotation`);
  }
};

/* Returns an array of [key, label] pairs that are currently usable */
const getAvailableKeys = () => {
  checkReset(keyState.k1);
  checkReset(keyState.k2);
  const keys = [];
  if (keyState.k1.key && !keyState.k1.exhausted) keys.push(keyState.k1);
  if (keyState.k2.key && !keyState.k2.exhausted) keys.push(keyState.k2);
  /* If BOTH exhausted, force reset and try anyway */
  if (keys.length === 0) {
    keyState.k1.exhausted = false;
    keyState.k2.exhausted = false;
    if (keyState.k1.key) keys.push(keyState.k1);
    if (keyState.k2.key) keys.push(keyState.k2);
    console.warn('⚠️  Both keys exhausted — forced reset, retrying...');
  }
  return keys;
};

/* Mark a key as exhausted (429) — reset after 60s */
const markExhausted = (label) => {
  const ks = label === 'KEY1' ? keyState.k1 : keyState.k2;
  ks.exhausted = true;
  ks.resetAt   = Date.now() + 60_000;
  console.warn(`🚫  ${label} quota exhausted — pausing for 60s`);
};

/* ── ALL 9 FREE-QUOTA GEMINI MODELS ──────────────────────────────── */
const GEMINI_MODELS = [
  'gemini-2.0-flash',          // 🔮 Primary — fastest, smartest
  'gemini-2.0-flash-lite',     // ⚡ Ultra-light — best on slow networks
  'gemini-1.5-flash',          // 🌊 Balanced speed + quality
  'gemini-1.5-flash-8b',       // 🐦 Compact, reliable backup
  'gemini-2.5-pro',            // 💎 Smartest — hard maths & reasoning
  'gemma-3-27b-it',            // 🦁 Open-source giant
  'gemma-3-12b-it',            // 🐯 Mid-size open model
  'gemma-3-4b-it',             // 🐼 Lightweight open model
  'gemma-3-1b-it',             // 🐣 Tiny but mighty — fastest fallback
];

/* ── TIMEOUT HELPER ──────────────────────────────────────────────── */
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`timeout_${ms}`)), ms)
    ),
  ]);

/* ═══════════════════════════════════════════════════════════════════
   🚀  CORE GEMINI CALL
   Makes ONE call to a specific model + key combo.
   Returns text string or throws.
═══════════════════════════════════════════════════════════════════ */
const callGeminiModel = async (model, apiKey, keyLabel, messages, systemInstruction, maxTokens = 1500) => {
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7,
      topP: 0.9,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    12000
  );

  if (res.status === 429) {
    markExhausted(keyLabel);
    throw new Error(`quota_${keyLabel}`);
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`gemini_${res.status}: ${err.slice(0, 120)}`);
  }

  const data  = await res.json();
  const text  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.trim().length < 5) throw new Error('empty_response');
  return text.trim();
};

/* ═══════════════════════════════════════════════════════════════════
   🏁  RACE ENGINE
   All 9 models × all available keys race simultaneously.
   First valid response wins. Promise.any() — NEVER hangs.
═══════════════════════════════════════════════════════════════════ */
const raceGemini = async (messages, systemInstruction, maxTokens = 1500) => {
  const keys = getAvailableKeys();
  if (keys.length === 0) throw new Error('no_keys_configured');

  const races = [];

  /* Build one race per model × key combo */
  for (const ks of keys) {
    ks.calls++;
    for (const model of GEMINI_MODELS) {
      races.push(
        callGeminiModel(model, ks.key, ks.label, messages, systemInstruction, maxTokens)
          .then(text => ({ text, model, key: ks.label }))
      );
    }
  }

  /* Promise.any — first success wins */
  const winner = await Promise.any(races);
  console.log(`✅  Winner: ${winner.model} via ${winner.key} (${winner.text.length} chars)`);
  return winner;
};

/* ── NORMALIZE MESSAGES (same logic as client) ──────────────────── */
const normalizeMessages = (msgs) => {
  const out = msgs
    .map(m => ({
      role: (m.role === 'assistant' || m.r === 'a') ? 'assistant' : 'user',
      content: String(m.content || m.c || '').trim(),
    }))
    .filter(m => m.content.length > 0);

  if (!out.length || out[0].role !== 'user')
    out.unshift({ role: 'user', content: 'Hello' });

  /* Merge consecutive same-role messages */
  const merged = [];
  for (const m of out) {
    if (merged.length && merged[merged.length - 1].role === m.role)
      merged[merged.length - 1].content += '\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
};

/* ═══════════════════════════════════════════════════════════════════
   📐  SYSTEM PROMPTS for each endpoint
═══════════════════════════════════════════════════════════════════ */

const SYS_TUTOR = (topic = '') => `
You are MASTERJI — India's most beloved AI school teacher for Classes 1-12.
Your superpower: make ANY concept instantly clear to any Indian student.

TEACHING RULES:
• Mix Hindi + English naturally (Hinglish). Use: "Dekho yaar...", "Iska matlab hai...", "Bilkul sahi!"
• ALWAYS start with one WOW fact that surprises the student
• Use Indian examples: IPL, chai, auto-rickshaw, Swiggy, IRCTC, cricket, Bollywood
• Emoji on every key point. Keep energy HIGH — like a coach, not a boring teacher
• Board exam focus: mention marks value [1M][2M][3M] where relevant
• End every reply with ONE follow-up question to keep learning going
• NANO BANANA MODE: assume student knows NOTHING. Build from zero. No jargon without instant explanation.
${topic ? `Current topic: ${topic}` : ''}
`.trim();

const SYS_LESSON = (topic, cls, subject) => `
You are creating an UNFORGETTABLE lesson on "${topic}" for Class ${cls || '5'}${subject && subject !== 'Explore Anything' ? ` (${subject})` : ''}.

RULES:
• 100% NCERT-accurate. Start with a WOW fact.
• Nano Banana style — teach from absolute zero
• Each teach point = emoji + 1 clear sentence + 1 vivid Indian example
• Memory trick = acronym or mini-story — genuinely impossible to forget
• Exam connect: mark if this topic is ⭐ frequently asked in board exams

Return ONLY raw JSON (no markdown, no backticks):
{
  "title": "🔥 Catchy title with emoji",
  "concept": "WOW opening fact. Then 2 sentences explaining the CORE idea simply.",
  "teach": [
    "🎯 Point 1: concept + vivid Indian example + [marks hint]",
    "⚡ Point 2: next idea + desi example",
    "🧠 Point 3: deeper understanding + real-life link",
    "🏆 Point 4: exam application + how to write in answer sheet"
  ],
  "examples": [
    "🇮🇳 Specific Indian example 1",
    "💡 Example 2 — something they see daily",
    "📖 Example 3 — from NCERT exercise"
  ],
  "memoryTrick": "🧠 TRICK: Clever acronym or 1-line story that makes it IMPOSSIBLE to forget on exam day"
}
`.trim();

const SYS_NOTES = (topic, cls) => `
You are creating SMART REVISION NOTES on "${topic}" for Class ${cls || '10'} Indian board exam.

RULES:
• 100% NCERT-aligned — every point examinable
• Include exact formulas, definitions, units
• Mark exam importance: ⭐ = definitely in exam, ⭐⭐ = very likely
• Include an Indian real-life example for every key concept
• Include a memory trick per section

Return ONLY raw JSON (no markdown, no backticks):
{
  "title": "${topic} — Quick Revision Notes",
  "keyPoints": [
    {"k": "Definition ⭐", "v": "Exact definition + [1M]"},
    {"k": "Key Formula ⭐⭐", "v": "Formula with explanation"},
    {"k": "How It Works", "v": "Step-by-step process"},
    {"k": "Indian Example 🇮🇳", "v": "Real-life example"},
    {"k": "Exam Tip ⭐⭐", "v": "Exactly what to write in exam for full marks"}
  ],
  "formula": "Main formula here or null",
  "examTips": [
    "Tip 1 — marks strategy",
    "Tip 2 — common mistakes to avoid",
    "Tip 3 — diagram if needed"
  ],
  "quickRevision": "One-line summary of the entire topic",
  "memoryTrick": "🧠 Clever trick to remember everything"
}
`.trim();

const SYS_QUIZ = (topic, cls, subject, count) => `
You are an Indian board exam paper setter. Create ${count || 5} exam-style MCQ questions on "${topic}" for Class ${cls || '5'}${subject && subject !== 'Explore Anything' ? ` (${subject})` : ''}.

STRICT EXAM RULES:
• Pattern: exactly like CBSE/State board MCQs — direct, clear, no tricks
• 100% factually correct answers — verified against NCERT
• Distractors = common student mistakes (not random wrong options)
• Explanation = what examiner expects + marks value [1M][2M][3M]
• Include at least 1 diagram-based or application question

Return ONLY raw JSON array (no markdown, no backticks):
[{"q": "Exam-style question?", "opts": ["A", "B", "C", "D"], "ans": 0, "exp": "✅ Correct because... [xM] Board tip: write this in exam"}]
ans = 0-3 index.
`.trim();

const SYS_WHITEBOARD = (topic) => `
You are MASTERJI — writing on a DIGITAL WHITEBOARD to explain "${topic || 'this concept'}" step by step, exactly like a real teacher at a blackboard.

WHITEBOARD RULES:
• Write in SECTIONS — each section = one "board write" step
• Use ═══ separators between sections (these become new whiteboard panels)
• Start each section with a bold header like: 📌 STEP 1: ...
• Write formulas/equations clearly: use ASCII art or plain text
  Example:  F = m × a   (Force = Mass × Acceleration)
• Draw simple ASCII diagrams when helpful:
  Example:
    [Sun] ──rays──> [Leaf] ──produces──> [Glucose + O₂]
• Use ✏️ for key terms being defined (like underline on board)
• Use 📦 BOX: for important formulas (like box on board)
• Use ⚠️ COMMON MISTAKE: for frequent errors
• Use ✅ EXAM TIP: for board exam strategies
• At the end, write a QUICK RECAP section
• Language: Mix Hinglish — warm, encouraging, like a real teacher
• Each STEP must be self-contained so student can scroll and follow

WHITEBOARD SECTIONS FORMAT:
═══════════════════════════════
📌 STEP 1: [Title]
...content...
═══════════════════════════════
📌 STEP 2: [Title]
...content...
═══════════════════════════════

Make it genuinely teach the concept from ZERO.
`.trim();

/* ═══════════════════════════════════════════════════════════════════
   🌐  MIDDLEWARE
═══════════════════════════════════════════════════════════════════ */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

/* Global rate limiter — prevents abuse */
const limiter = rateLimit({
  windowMs: 60_000,  // 1 minute window
  max: 120,          // 120 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down!', retry: 60 },
});
app.use(limiter);

/* Session header passthrough */
app.use((req, res, next) => {
  req.sessionId = req.headers['x-session-id'] || uuidv4();
  res.setHeader('x-session-id', req.sessionId);
  next();
});

/* ─── Health check ──────────────────────────────────────────────── */
app.get('/', (_, res) => {
  res.json({
    status: 'ok',
    name: 'MicroMind v25 Server',
    models: GEMINI_MODELS.length,
    keys: [!!KEY1, !!KEY2].filter(Boolean).length,
    endpoints: ['/api/ai', '/api/lesson', '/api/notes', '/api/whiteboard', '/api/quiz', '/api/quota'],
  });
});

/* ─── Quota info ────────────────────────────────────────────────── */
app.get('/api/quota', (req, res) => {
  res.json({
    sessionId: req.sessionId,
    key1: { available: !!KEY1, exhausted: keyState.k1.exhausted, calls: keyState.k1.calls },
    key2: { available: !!KEY2, exhausted: keyState.k2.exhausted, calls: keyState.k2.calls },
    models: GEMINI_MODELS.length,
    status: 'racing',
  });
});

/* ═══════════════════════════════════════════════════════════════════
   💬  /api/ai  — General tutor chat
═══════════════════════════════════════════════════════════════════ */
app.post('/api/ai', async (req, res) => {
  try {
    const { messages = [], system, max = 1500, type = 'chat', topic = '' } = req.body;

    const norm = normalizeMessages(messages);
    const sys  = system || SYS_TUTOR(topic);

    const { text, model, key } = await raceGemini(norm, sys, Math.min(max, 2000));

    res.json({ text, model, key, sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/ai]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   📖  /api/lesson  — Generate full Nano Banana lesson
═══════════════════════════════════════════════════════════════════ */
app.post('/api/lesson', async (req, res) => {
  try {
    const { topic = 'Photosynthesis', cls = '10', subject = '' } = req.body;

    const norm = [{ role: 'user', content: `Generate a full lesson on: ${topic} for class ${cls}` }];
    const sys  = SYS_LESSON(topic, cls, subject);

    const { text, model, key } = await raceGemini(norm, sys, 1800);

    /* Try to parse JSON, fallback to raw text */
    let lesson;
    try {
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      lesson = JSON.parse(clean.match(/(\{[\s\S]*\})/)?.[1] || clean);
    } catch {
      lesson = { title: `🔥 ${topic} — Let's Master It!`, raw: text };
    }

    res.json({ lesson, model, key, sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/lesson]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   📝  /api/notes  — Generate smart revision notes
═══════════════════════════════════════════════════════════════════ */
app.post('/api/notes', async (req, res) => {
  try {
    const { topic = 'Newton\'s Laws', cls = '10' } = req.body;

    const norm = [{ role: 'user', content: `Generate revision notes on: ${topic} for class ${cls}` }];
    const sys  = SYS_NOTES(topic, cls);

    const { text, model, key } = await raceGemini(norm, sys, 1800);

    let notes;
    try {
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      notes = JSON.parse(clean.match(/(\{[\s\S]*\})/)?.[1] || clean);
    } catch {
      notes = { title: `${topic} — Notes`, raw: text };
    }

    res.json({ notes, model, key, sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/notes]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ✏️  /api/whiteboard  — Solve doubt on a scrollable whiteboard
   Returns step-by-step teacher writing sections.
   Each section separated by ═══ markers for the frontend to split.
═══════════════════════════════════════════════════════════════════ */
app.post('/api/whiteboard', async (req, res) => {
  try {
    const { messages = [], topic = '', doubt = '' } = req.body;

    /* Build conversation — user's doubt as last message */
    const baseMessages = messages.length
      ? normalizeMessages(messages)
      : [{ role: 'user', content: doubt || topic || 'Explain this concept step by step.' }];

    const sys = SYS_WHITEBOARD(topic || doubt);

    const { text, model, key } = await raceGemini(baseMessages, sys, 2000);

    /* Split into whiteboard panels on ═══ separator */
    const panels = text
      .split(/═{3,}/)
      .map(p => p.trim())
      .filter(p => p.length > 10);

    res.json({
      raw: text,
      panels,                          /* Array of panel strings for frontend rendering */
      panelCount: panels.length,
      model,
      key,
      sessionId: req.sessionId,
      ok: true,
    });
  } catch (err) {
    console.error('[/api/whiteboard]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   🎯  /api/quiz  — Generate MCQ quiz
═══════════════════════════════════════════════════════════════════ */
app.post('/api/quiz', async (req, res) => {
  try {
    const { topic = 'Photosynthesis', cls = '10', subject = '', count = 5 } = req.body;

    const norm = [{ role: 'user', content: `Create ${count} MCQ questions on: ${topic} class ${cls}` }];
    const sys  = SYS_QUIZ(topic, cls, subject, count);

    const { text, model, key } = await raceGemini(norm, sys, 1500);

    let quiz;
    try {
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const match = clean.match(/(\[[\s\S]*\])/);
      quiz = JSON.parse(match ? match[1] : clean);
      if (!Array.isArray(quiz)) throw new Error('not_array');
    } catch {
      /* Fallback single question */
      quiz = [{
        q: `Define ${topic} and explain with an example.`,
        opts: ['Definition + example', 'Definition only', 'Example only', 'Skip'],
        ans: 0,
        exp: '✅ Always write definition + example for full marks! [2M]',
      }];
    }

    res.json({ quiz, model, key, sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/quiz]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   🚀  START SERVER
═══════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  🧠  MicroMind v25 Server — RUNNING          ║
  ║  📡  Port      : ${String(PORT).padEnd(26)}║
  ║  🔑  API Key 1 : ${(KEY1 ? '✅ SET' : '❌ MISSING').padEnd(26)}║
  ║  🔑  API Key 2 : ${(KEY2 ? '✅ SET' : '❌ MISSING').padEnd(26)}║
  ║  🏁  Models    : ${String(GEMINI_MODELS.length + ' Gemini racing').padEnd(26)}║
  ╠══════════════════════════════════════════════╣
  ║  Endpoints:                                  ║
  ║  POST /api/ai          → Tutor chat          ║
  ║  POST /api/lesson      → Generate lesson     ║
  ║  POST /api/notes       → Revision notes      ║
  ║  POST /api/whiteboard  → Teacher whiteboard  ║
  ║  POST /api/quiz        → MCQ quiz            ║
  ║  GET  /api/quota       → Key status          ║
  ╚══════════════════════════════════════════════╝
  `);
});
