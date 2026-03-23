/* ════════════════════════════════════════════════════════════════
   🧠 MicroMind Server — Gemini AI Studio (Primary) + Pollinations (Fallback)
   
   QUOTA PER SESSION (resets every 24h):
     Chat    → 10 uses  → AI Studio (Gemini 2.0 Flash)
     Lesson  → 5 uses   → AI Studio
     Visual  → 10 uses  → AI Studio
     Coding  → 15 uses  → AI Studio
     Over quota → auto fallback to Pollinations AI (free, no key)
   ════════════════════════════════════════════════════════════════ */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));

/* ── QUOTA CONFIG — change these numbers anytime ── */
const QUOTAS = {
  chat:   10,   // 10 AI Studio calls for chat
  lesson:  5,   // 5  AI Studio calls for lesson generation
  visual: 10,   // 10 AI Studio calls for visual notes
  coding: 15,   // 15 AI Studio calls for coding lessons
};

/* ── IN-MEMORY SESSION STORE ──
   Each user gets a session ID (UUID) stored in their browser (localStorage).
   Resets after 24 hours. For production you can swap this with Redis. */
const sessions = new Map();

function getOrCreateSession(sid) {
  // If no sid given or unknown, create fresh
  if (!sid || !sessions.has(sid)) {
    const newId = crypto.randomUUID();
    sessions.set(newId, {
      id:        newId,
      createdAt: Date.now(),
      usage:     { chat: 0, lesson: 0, visual: 0, coding: 0 }
    });
    return sessions.get(newId);
  }
  return sessions.get(sid);
}

// Auto-clean sessions older than 24 hours (runs every 30 min)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(key);
  }
}, 30 * 60 * 1000);

/* ════════════════════════════════════════════════════════════════
   🤖  GEMINI AI STUDIO CALLER
   Uses gemini-2.0-flash — best free model on AI Studio
   Get your free API key: https://aistudio.google.com/apikey
════════════════════════════════════════════════════════════════ */
async function callGemini(messages, system, maxTokens = 1800) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set in environment');

  // Convert OpenAI-style messages → Gemini format
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content).trim() }]
  }));

  // Gemini requires alternating user/model roles — merge consecutive same-role
  const merged = [];
  for (const msg of contents) {
    if (merged.length && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].parts[0].text += '\n' + msg.parts[0].text;
    } else {
      merged.push({ ...msg, parts: [{ text: msg.parts[0].text }] });
    }
  }
  // Must start with user
  if (!merged.length || merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  const requestBody = {
    contents: merged,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature: 0.82,
      topP: 0.95,
    }
  };

  // Add system instruction if provided
  if (system && system.trim()) {
    requestBody.systemInstruction = { parts: [{ text: system.trim() }] };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(requestBody),
      signal:  AbortSignal.timeout(22000)   // 22s timeout
    }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 120)}`);
  }

  const data = await res.json();

  // Check for safety blocks
  if (data.candidates?.[0]?.finishReason === 'SAFETY') {
    throw new Error('Gemini safety block');
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.length < 4) throw new Error('Gemini returned empty response');

  return text.trim();
}

/* ════════════════════════════════════════════════════════════════
   🌟  POLLINATIONS FALLBACK (server-side, used if Gemini fails)
   Only used when: (a) quota exceeded, or (b) Gemini errors out
════════════════════════════════════════════════════════════════ */
async function callPollinations(messages, system, maxTokens = 1800) {
  const models = ['openai-large', 'openai', 'mistral', 'llama'];

  for (const model of models) {
    try {
      const body = {
        model,
        messages: system
          ? [{ role: 'system', content: system }, ...messages]
          : messages,
        max_tokens: Math.min(maxTokens, 2048),
        seed: Math.floor(Math.random() * 9999)
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 14000);

      const res = await fetch('https://text.pollinations.ai/openai', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) continue;
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text && text.length > 4) return text.trim();
    } catch (_) { /* try next model */ }
  }

  throw new Error('All Pollinations models failed');
}

/* ════════════════════════════════════════════════════════════════
   📡  POST /api/ai  — Main endpoint called by the frontend
   
   Request body:
     messages  — array of {role, content}
     system    — system prompt string (optional)
     max       — max tokens (optional, default 1600)
     type      — "chat" | "lesson" | "visual" | "coding" (for quota tracking)
   
   Response:
     text      — the AI response
     ai        — which AI was used: "gemini" | "pollinations"
     sessionId — session UUID (save this in localStorage)
     remaining — { chat, lesson, visual, coding } — how many AI Studio calls left
════════════════════════════════════════════════════════════════ */
app.post('/api/ai', async (req, res) => {
  try {
    const {
      messages = [],
      system   = '',
      max      = 1600,
      type     = 'chat'   // which quota bucket to use
    } = req.body;

    if (!messages.length) {
      return res.status(400).json({ error: 'No messages provided' });
    }

    // ── SESSION ──
    const incomingSid = req.headers['x-session-id'] || '';
    const session = getOrCreateSession(incomingSid);
    res.setHeader('x-session-id', session.id);

    // ── QUOTA CHECK ──
    const bucketKey  = QUOTAS[type] !== undefined ? type : 'chat';
    const quotaLimit = QUOTAS[bucketKey];
    const usedSoFar  = session.usage[bucketKey] || 0;
    const withinQuota = usedSoFar < quotaLimit;

    let responseText = null;
    let aiUsed       = 'pollinations';

    // ── TRY GEMINI (AI STUDIO) FIRST ──
    if (withinQuota) {
      try {
        responseText = await callGemini(messages, system, max);
        session.usage[bucketKey] = usedSoFar + 1;
        aiUsed = 'gemini';
        console.log(`[Gemini ✅] type=${type} used=${session.usage[bucketKey]}/${quotaLimit} sid=${session.id.slice(0,8)}`);
      } catch (geminiErr) {
        console.warn(`[Gemini ⚠️] Failed (${geminiErr.message}), falling to Pollinations`);
      }
    } else {
      console.log(`[Quota 🔒] type=${type} limit reached (${quotaLimit}), using Pollinations. sid=${session.id.slice(0,8)}`);
    }

    // ── FALLBACK TO POLLINATIONS ──
    if (!responseText) {
      try {
        responseText = await callPollinations(messages, system, max);
        aiUsed = 'pollinations';
        console.log(`[Pollinations ✅] sid=${session.id.slice(0,8)}`);
      } catch (pollinationsErr) {
        console.error(`[Pollinations ❌] ${pollinationsErr.message}`);
        // Last resort — tell frontend to use its own built-in endpoints
        return res.json({
          text:      null,
          ai:        'client-fallback',
          sessionId: session.id,
          remaining: buildRemaining(session)
        });
      }
    }

    return res.json({
      text:      responseText,
      ai:        aiUsed,
      sessionId: session.id,
      remaining: buildRemaining(session)
    });

  } catch (err) {
    console.error('[Server Error]', err.message);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

/* ── Helper: build remaining quota object ── */
function buildRemaining(session) {
  return {
    chat:   Math.max(0, QUOTAS.chat   - (session.usage.chat   || 0)),
    lesson: Math.max(0, QUOTAS.lesson - (session.usage.lesson || 0)),
    visual: Math.max(0, QUOTAS.visual - (session.usage.visual || 0)),
    coding: Math.max(0, QUOTAS.coding - (session.usage.coding || 0)),
  };
}

/* ════════════════════════════════════════════════════════════════
   📊  GET /api/quota  — Check remaining quota for a session
════════════════════════════════════════════════════════════════ */
app.get('/api/quota', (req, res) => {
  const sid = req.headers['x-session-id'] || '';
  const session = getOrCreateSession(sid);
  res.setHeader('x-session-id', session.id);
  res.json({
    sessionId: session.id,
    remaining: buildRemaining(session),
    limits:    QUOTAS
  });
});

/* ── Health check (Render uses this to detect app is up) ── */
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

/* ── Serve the frontend HTML from root folder ── */
app.use(express.static(__dirname));
app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, 'MicroMind_v22.html');
  const fs = require('fs');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#F5F3FF">
        <h1 style="color:#7C3AED">🧠 MicroMind Server is Running! ✅</h1>
        <p style="color:#666;font-size:18px">But <b>MicroMind_v22.html</b> is missing from your repo.</p>
        <p style="color:#666">Please upload <b>MicroMind_v22.html</b> to your GitHub repo root folder.</p>
        <p style="margin-top:30px;color:#059669;font-size:16px">✅ Gemini AI Studio: ${process.env.GEMINI_API_KEY ? 'Key Loaded' : 'Key Missing'}</p>
        <p style="color:#059669">✅ API endpoints /api/ai and /api/quota are working!</p>
      </body></html>
    `);
  }
});

/* ── START ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 MicroMind server running on port ${PORT}`);
  console.log(`📡 Gemini AI Studio: ${process.env.GEMINI_API_KEY ? '✅ Key loaded' : '❌ GEMINI_API_KEY not set!'}`);
  console.log(`📊 Quotas: Chat=${QUOTAS.chat} Lesson=${QUOTAS.lesson} Visual=${QUOTAS.visual} Coding=${QUOTAS.coding}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
