/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   MicroMind v25 — AI Tutor Server                               ║
 * ║   Deploy on Render.com (free tier) — zero billing               ║
 * ║                                                                  ║
 * ║   ENV VARS to set in Render dashboard:                           ║
 * ║     GEMINI_API_KEY  →  your Google AI Studio key (free)         ║
 * ║     PORT            →  set automatically by Render              ║
 * ║                                                                  ║
 * ║   Endpoints:                                                     ║
 * ║     POST /api/ai          → chat / lesson / notes / quiz        ║
 * ║     POST /api/whiteboard  → AI Whiteboard (NEW 🖊️)             ║
 * ║     GET  /api/quota       → session health check                ║
 * ║     GET  /health          → server alive check                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

/* ─── CONFIG ──────────────────────────────────────────────────────── */
const PORT          = process.env.PORT || 3000;
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT = 18000; // 18s per model call

/* ══════════════════════════════════════════════════════════════════════
   9 FREE GEMINI MODELS — All race via Promise.any(), fastest wins!
   Each model has a dedicated role so the right brain is used each time.
══════════════════════════════════════════════════════════════════════ */
const GEMINI_MODELS = [
  // Speed tier — fastest, best for chat & tutoring
  { id: 'gemini-2.0-flash',        emoji: '🔮', role: 'chat',    priority: 1 },
  { id: 'gemini-2.0-flash-lite',   emoji: '⚡', role: 'chat',    priority: 1 },
  { id: 'gemini-1.5-flash',        emoji: '🌊', role: 'lesson',  priority: 2 },
  { id: 'gemini-1.5-flash-8b',     emoji: '🐦', role: 'lesson',  priority: 2 },
  // Power tier — best for whiteboard, coding, complex reasoning
  { id: 'gemini-2.5-pro',          emoji: '💎', role: 'whiteboard', priority: 3 },
  // Open-source Gemma — great explainers, used for notes & coding
  { id: 'gemma-3-27b-it',          emoji: '🦁', role: 'coding',  priority: 2 },
  { id: 'gemma-3-12b-it',          emoji: '🐯', role: 'notes',   priority: 2 },
  { id: 'gemma-3-4b-it',           emoji: '🐼', role: 'coding',  priority: 3 },
  { id: 'gemma-3-1b-it',           emoji: '🐣', role: 'chat',    priority: 3 },
];

/* ─── AI ROUTING: which models lead for each task type ───────────── */
const TASK_ROUTING = {
  chat:       ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemma-3-1b-it'],
  lesson:     ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemma-3-12b-it'],
  notes:      ['gemma-3-12b-it',   'gemini-1.5-flash', 'gemini-2.0-flash'],
  quiz:       ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemma-3-4b-it'],
  coding:     ['gemma-3-27b-it',   'gemma-3-4b-it',    'gemini-2.0-flash'],
  whiteboard: ['gemini-2.5-pro',   'gemini-2.0-flash', 'gemma-3-27b-it'],
  battle:     ['gemini-2.0-flash-lite', 'gemma-3-1b-it', 'gemini-1.5-flash-8b'],
};

/* ─── SESSION STORE (in-memory, resets on server restart) ─────────── */
const sessions = new Map();
let totalRequests = 0;
let totalServed   = 0;

function getOrCreateSession(id) {
  if (!id || !sessions.has(id)) {
    const newId = 'mm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    sessions.set(newId, { id: newId, requests: 0, created: Date.now() });
    return sessions.get(newId);
  }
  return sessions.get(id);
}

/* ──────────────────────────────────────────────────────────────────
   CORE: Call a single Gemini model
────────────────────────────────────────────────────────────────── */
async function callGeminiModel(modelId, messages, systemPrompt, maxTokens = 1200) {
  if (!GEMINI_KEY) throw new Error('No GEMINI_API_KEY set');

  // Convert OpenAI-style messages → Gemini `contents` format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.75,
      topP: 0.95,
    },
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(
      `${GEMINI_BASE}/${modelId}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`${modelId}: HTTP ${res.status} — ${err.slice(0, 120)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim().length < 4) throw new Error(`${modelId}: empty response`);

    return { text: text.trim(), model: modelId };
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────────────────────────────────────────────────
   RACE: ALL 9 models simultaneously — Promise.any() returns winner
   Extra: task-routing moves the best models to front of the race
────────────────────────────────────────────────────────────────── */
async function raceAllGeminiModels(messages, systemPrompt, maxTokens, taskType = 'chat') {
  const preferred = TASK_ROUTING[taskType] || TASK_ROUTING.chat;

  // Sort: preferred models race first, rest follow in parallel
  const orderedModels = [
    ...GEMINI_MODELS.filter(m => preferred.includes(m.id)),
    ...GEMINI_MODELS.filter(m => !preferred.includes(m.id)),
  ];

  const promises = orderedModels.map(m =>
    callGeminiModel(m.id, messages, systemPrompt, maxTokens)
  );

  // Promise.any → first non-rejected wins 🏆
  return Promise.any(promises);
}

/* ══════════════════════════════════════════════════════════════════════
   🖊️  AI WHITEBOARD ENGINE
   Generates a lesson as a structured whiteboard:
   — Title, concept explanation, steps, diagram, formula, memory trick
   — Each "step" mimics a human writing a new section on the board
   — Returns JSON that the frontend renders as a scrollable canvas
══════════════════════════════════════════════════════════════════════ */
const WHITEBOARD_SYSTEM = `You are MicroMind's AI WHITEBOARD — like a genius teacher writing a lesson on a big scrollable whiteboard.

CRITICAL RULES:
• Write like a HUMAN TEACHER physically writing on a whiteboard — short bursts, one idea at a time
• Use REAL Indian examples: IPL, chai, auto, IRCTC, Swiggy, ISRO, Bollywood, gully cricket
• Every step = one clear "board section" — not more than 3 lines
• Include a Mermaid diagram when the concept has a flow or process
• 100% NCERT accurate

Return ONLY raw JSON (no markdown, no backticks, no explanation outside JSON):
{
  "title": "🔥 Topic — catchy hook",
  "subtitle": "Class X | Subject | one-line tease",
  "steps": [
    {
      "id": 1,
      "type": "concept",
      "heading": "📌 What is it?",
      "body": "2-3 sentences max — the simplest possible explanation",
      "chalk": "white"
    },
    {
      "id": 2,
      "type": "example",
      "heading": "🇮🇳 Real-Life (India!)",
      "body": "Vivid Indian example they will NEVER forget",
      "chalk": "yellow"
    },
    {
      "id": 3,
      "type": "formula",
      "heading": "⚡ Key Formula / Rule",
      "body": "Formula or key rule — boxed on board",
      "chalk": "cyan"
    },
    {
      "id": 4,
      "type": "diagram",
      "heading": "📊 Visual (Mermaid)",
      "mermaid": "graph TD\\n  A[Start] --> B[Process] --> C[Result]",
      "chalk": "green"
    },
    {
      "id": 5,
      "type": "trick",
      "heading": "🧠 Memory Trick",
      "body": "Acronym or 1-line story that sticks forever",
      "chalk": "pink"
    },
    {
      "id": 6,
      "type": "exam",
      "heading": "⭐ Board Exam Tip",
      "body": "Exactly what to write for full marks. Mark value hints.",
      "chalk": "orange"
    }
  ],
  "quickRevision": "3 power-lines: Definition. How it works. Why important.",
  "memoryTrick": "The one trick that makes this impossible to forget on exam day"
}

ALWAYS include at least 6 steps. Step type 'diagram' MUST have a valid Mermaid code string.`;

/* ══════════════════════════════════════════════════════════════════════
   EXPRESS APP
══════════════════════════════════════════════════════════════════════ */
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-session-id'],
  exposedHeaders: ['x-session-id', 'x-model-used'],
}));

app.use(express.json({ limit: '64kb' }));

// Trust Render's proxy for rate-limiting
app.set('trust proxy', 1);

/* ─── Rate limiting — generous for students ───────────────────────── */
const limiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute window
  max: 60,                  // 60 requests/min per IP (very generous)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — wait 1 minute and try again 😊' },
});
app.use('/api/', limiter);

/* ─── Session middleware ─────────────────────────────────────────── */
app.use('/api/', (req, _res, next) => {
  totalRequests++;
  req.session = getOrCreateSession(req.headers['x-session-id']);
  req.session.requests++;
  next();
});

/* ──────────────────────────────────────────────────────────────────
   GET /health  — Render health check (keeps free dyno alive)
────────────────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: 'MicroMind v25',
    models: GEMINI_MODELS.length,
    uptime: Math.round(process.uptime()),
    totalRequests,
    totalServed,
  });
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/quota  — Session health + model list
────────────────────────────────────────────────────────────────── */
app.get('/api/quota', (req, res) => {
  res.set('x-session-id', req.session.id);
  res.json({
    ok: true,
    sessionId: req.session.id,
    sessionRequests: req.session.requests,
    serverRequests: totalRequests,
    geminiModels: GEMINI_MODELS.map(m => ({ id: m.id, emoji: m.emoji, role: m.role })),
    geminiKey: GEMINI_KEY ? '✅ set' : '❌ missing — add GEMINI_API_KEY env var',
    taskRouting: TASK_ROUTING,
  });
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/ai  — Main AI endpoint
   Body: { messages, system, max, type }
   type: 'chat' | 'lesson' | 'notes' | 'quiz' | 'coding' | 'battle'
────────────────────────────────────────────────────────────────── */
app.post('/api/ai', async (req, res) => {
  const { messages, system, max = 1200, type = 'chat' } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Normalize messages — merge consecutive same-role turns
  const norm = normalizeMessages(messages);

  try {
    const result = await raceAllGeminiModels(norm, system, Math.min(max, 2000), type);
    totalServed++;

    res.set('x-session-id', req.session.id);
    res.set('x-model-used', result.model);

    return res.json({
      text: result.text,
      model: result.model,
      sessionId: req.session.id,
      taskType: type,
    });
  } catch (err) {
    console.error('[/api/ai] All models failed:', err?.message || err);
    return res.status(503).json({
      error: 'All Gemini models failed — check your API key or try again',
      hint: 'Add GEMINI_API_KEY in Render > Environment > Add Env Var',
    });
  }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/whiteboard  — 🖊️ AI WHITEBOARD (NEW!)
   Body: { topic, cls, subject }
   Returns: whiteboard JSON with steps, mermaid diagrams, chalk colors
────────────────────────────────────────────────────────────────── */
app.post('/api/whiteboard', async (req, res) => {
  const { topic = 'Photosynthesis', cls = '8', subject = 'Science' } = req.body;

  if (!topic || topic.trim().length < 2) {
    return res.status(400).json({ error: 'topic is required' });
  }

  // Build the whiteboard prompt
  const userMsg = `Create a WHITEBOARD LESSON on: "${topic}" for Class ${cls} ${subject} students in India.

Rules:
- Write like a human teacher with a marker on a board
- Real Indian examples (IPL, chai, ISRO, Swiggy, auto-rickshaw)
- Include a Mermaid diagram for the concept flow
- Memory trick that ACTUALLY sticks on exam day
- 100% NCERT accurate`;

  const messages = [{ role: 'user', content: userMsg }];

  try {
    // Whiteboard uses the smartest models: Gemini 2.5 Pro leads the race
    const result = await raceAllGeminiModels(
      messages,
      WHITEBOARD_SYSTEM,
      2000,
      'whiteboard'
    );

    totalServed++;

    // Parse the JSON from the model response
    const parsed = parseJSON(result.text);

    if (!parsed || !parsed.steps) {
      // Return a fallback whiteboard if JSON parse fails
      return res.json({
        whiteboard: buildFallbackWhiteboard(topic, cls, subject),
        model: result.model,
        raw: false,
        sessionId: req.session.id,
      });
    }

    res.set('x-session-id', req.session.id);
    res.set('x-model-used', result.model);

    return res.json({
      whiteboard: parsed,
      model: result.model,
      raw: false,
      sessionId: req.session.id,
    });
  } catch (err) {
    console.error('[/api/whiteboard] Failed:', err?.message);
    return res.json({
      whiteboard: buildFallbackWhiteboard(topic, cls, subject),
      model: 'fallback',
      raw: false,
      sessionId: req.session.id,
    });
  }
});

/* ──────────────────────────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────────────────────────── */
function normalizeMessages(msgs) {
  const out = msgs
    .map(m => ({
      role: (m.role === 'assistant' || m.r === 'a') ? 'assistant' : 'user',
      content: String(m.content || m.c || '').trim(),
    }))
    .filter(m => m.content.length > 0);

  if (!out.length || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: 'Hello' });
  }

  // Merge consecutive same-role turns
  const merged = [];
  for (const m of out) {
    if (merged.length && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += '\n' + m.content;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

function parseJSON(txt) {
  const clean = txt
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try { return JSON.parse(clean); } catch (_) {}
  const m = clean.match(/(\{[\s\S]*\})/);
  if (m) try { return JSON.parse(m[1]); } catch (_) {}
  return null;
}

function buildFallbackWhiteboard(topic, cls, subject) {
  return {
    title: `🔥 ${topic} — Let's Master It!`,
    subtitle: `Class ${cls} | ${subject} | Board Exam Ready`,
    steps: [
      {
        id: 1, type: 'concept', chalk: 'white',
        heading: '📌 What is it?',
        body: `${topic} is a fundamental concept in ${subject} studied in Class ${cls}. It explains how things work in the natural or social world around us. Understanding this helps answer exam questions confidently!`,
      },
      {
        id: 2, type: 'example', chalk: 'yellow',
        heading: '🇮🇳 Real-Life Example',
        body: `You can see ${topic} in your daily Indian life — from cricket matches to chai-making to how your smartphone works! Look around and you'll find it everywhere.`,
      },
      {
        id: 3, type: 'formula', chalk: 'cyan',
        heading: '⚡ Key Rule',
        body: `RULE: Every concept has 3 parts — Definition + How it works + Why it matters. Learn these 3 for ${topic} and you'll never forget it!`,
      },
      {
        id: 4, type: 'diagram', chalk: 'green',
        heading: '📊 Concept Flow',
        mermaid: `graph TD\n  A["📚 ${topic}"] --> B["Definition"]\n  A --> C["How It Works"]\n  A --> D["Real-Life Use"]\n  B --> E["1 Mark ✅"]\n  C --> F["2-3 Marks ✅"]\n  D --> G["Full Marks! 🏆"]`,
      },
      {
        id: 5, type: 'trick', chalk: 'pink',
        heading: '🧠 Memory Trick',
        body: `D-H-W: DEFINE → HOW it works → WHERE you see it in India. Say it 3 times before your exam: "D-H-W, D-H-W, D-H-W!" ✅`,
      },
      {
        id: 6, type: 'exam', chalk: 'orange',
        heading: '⭐ Board Exam Tip',
        body: `Write: (1) Definition [1M] + (2) Explanation in 2 lines [2M] + (3) Indian example [1M] + (4) Diagram if asked [1M] = 5/5 marks every time! ⭐`,
      },
    ],
    quickRevision: `${topic}: What it is → How it works → Why important. 3 lines max!`,
    memoryTrick: `D-H-W: Define → How → Where. Never forget this on exam day! 🚀`,
  };
}

/* ──────────────────────────────────────────────────────────────────
   GET /  — Beautiful status homepage
────────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  const uptime = Math.round(process.uptime());
  const mins   = Math.floor(uptime / 60);
  const secs   = uptime % 60;
  const keyOk  = !!GEMINI_KEY;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MicroMind v25 — AI Tutor Server</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',sans-serif;background:#0F0A1E;color:#E9D5FF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:linear-gradient(135deg,#1E1B4B,#2D1B69);border-radius:24px;padding:36px 32px;max-width:480px;width:100%;border:2px solid #4C1D95;box-shadow:0 20px 60px rgba(79,29,150,.5);}
  .logo{font-size:52px;text-align:center;margin-bottom:12px;}
  h1{font-size:26px;font-weight:800;text-align:center;background:linear-gradient(135deg,#A78BFA,#E9D5FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;}
  .sub{text-align:center;color:#7C3AED;font-size:13px;font-weight:600;margin-bottom:28px;}
  .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(5,150,105,.15);border:1.5px solid #059669;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:700;color:#6EE7B7;margin-bottom:20px;width:100%;justify-content:center;}
  .section{background:rgba(0,0,0,.25);border-radius:16px;padding:16px 18px;margin-bottom:14px;border:1px solid rgba(124,58,237,.25);}
  .section-title{font-size:10px;font-weight:800;color:#6B7280;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;}
  .row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);}
  .row:last-child{border-bottom:none;}
  .row-label{font-size:13px;color:#9CA3AF;font-weight:500;}
  .row-val{font-size:13px;font-weight:700;color:#E9D5FF;}
  .ok{color:#6EE7B7;} .warn{color:#FCD34D;} .err{color:#FCA5A5;}
  .endpoint{background:rgba(0,0,0,.3);border-radius:10px;padding:8px 12px;font-family:monospace;font-size:12px;color:#A78BFA;margin-bottom:6px;border-left:3px solid #4C1D95;}
  .method{color:#FCD34D;margin-right:6px;font-weight:800;}
  .pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#10B981;box-shadow:0 0 0 0 rgba(16,185,129,.5);animation:pulse 1.5s infinite;}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5);}70%{box-shadow:0 0 0 8px rgba(16,185,129,0);}100%{box-shadow:0 0 0 0 rgba(16,185,129,0);}}
  .footer{text-align:center;font-size:11px;color:#4B5563;margin-top:18px;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">&#x1F9E0;</div>
  <h1>MicroMind v25</h1>
  <div class="sub">AI Tutor Server &middot; 9 Gemini Models Racing &middot; 100% Free</div>
  <div class="badge"><span class="pulse"></span> &#x2705; Server is Live &amp; Running!</div>
  <div class="section">
    <div class="section-title">&#x26A1; Server Status</div>
    <div class="row"><span class="row-label">Status</span><span class="row-val ok">&#x1F7E2; Online</span></div>
    <div class="row"><span class="row-label">Uptime</span><span class="row-val">${mins}m ${secs}s</span></div>
    <div class="row"><span class="row-label">Gemini API Key</span><span class="row-val ${keyOk ? 'ok' : 'err'}">${keyOk ? '&#x2705; Set & Ready' : '&#x274C; MISSING!'}</span></div>
    <div class="row"><span class="row-label">Models Racing</span><span class="row-val ok">${GEMINI_MODELS.length} Gemini Models &#x1F52E;</span></div>
    <div class="row"><span class="row-label">Total Requests</span><span class="row-val">${totalRequests} served</span></div>
  </div>
  <div class="section">
    <div class="section-title">&#x1F50C; API Endpoints</div>
    <div class="endpoint"><span class="method">GET</span>/health</div>
    <div class="endpoint"><span class="method">GET</span>/api/quota</div>
    <div class="endpoint"><span class="method">POST</span>/api/ai &mdash; { messages, system, max, type }</div>
    <div class="endpoint"><span class="method">POST</span>/api/whiteboard &mdash; { topic, cls, subject }</div>
  </div>
  ${!keyOk ? `<div class="section" style="border-color:#EF4444;"><div class="section-title" style="color:#EF4444;">&#x26A0; Action Required</div><div style="font-size:13px;color:#FCA5A5;line-height:1.7;">Add your <strong>GEMINI_API_KEY</strong> in Render Dashboard &rarr; Your Service &rarr; Environment</div></div>` : ''}
  <div class="footer">MicroMind v25 &middot; Made with &#x1F49C; for Indian Students &middot; 100% Free</div>
</div>
</body>
</html>`);
});

/* ──────────────────────────────────────────────────────────────────
   404 CATCH-ALL
────────────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({
    error: `Route '${req.method} ${req.path}' not found`,
    availableEndpoints: [
      'GET  /',
      'GET  /health',
      'GET  /api/quota',
      'POST /api/ai          — { messages, system, max, type }',
      'POST /api/whiteboard  — { topic, cls, subject }',
    ],
  });
});

/* ──────────────────────────────────────────────────────────────────
   START
────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  🧠 MicroMind v25 — AI Tutor Server               ║
║  Port: ${PORT}                                       ║
║  Gemini Key: ${GEMINI_KEY ? '✅ Set' : '❌ MISSING — set GEMINI_API_KEY'}         ║
║  Models racing: ${GEMINI_MODELS.length} Gemini models                ║
║  Endpoints: /api/ai  /api/whiteboard  /api/quota  ║
╚════════════════════════════════════════════════════╝
  `);
});

export default app;
