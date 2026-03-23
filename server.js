/* ════════════════════════════════════════════════════════════════
   🧠 MicroMind Server v2 — FIXED: Rate Limit + Parallel AI
   ─────────────────────────────────────────────────────────────────
   BUG FIXES:
   ✅ Fix 1: Dual Gemini models (2.0-flash + 1.5-flash) = 2x quota
   ✅ Fix 2: Rate limiter — max 12 calls/min per Gemini model
   ✅ Fix 3: Pollinations runs PARALLEL (Promise.any) not sequential
   ✅ Fix 4: If Gemini 429 → auto-switch to other Gemini model
   ✅ Fix 5: Server ALWAYS returns something — never leaves user hanging
   ════════════════════════════════════════════════════════════════ */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));

/* ── QUOTA CONFIG ── */
const QUOTAS = { chat: 15, lesson: 8, visual: 15, coding: 20 };

/* ── SESSION STORE ── */
const sessions = new Map();
function getOrCreateSession(sid) {
  if (!sid || !sessions.has(sid)) {
    const newId = crypto.randomUUID();
    sessions.set(newId, { id: newId, createdAt: Date.now(), usage: { chat:0, lesson:0, visual:0, coding:0 } });
    return sessions.get(newId);
  }
  return sessions.get(sid);
}
setInterval(() => {
  const cutoff = Date.now() - 86400000;
  for (const [k, s] of sessions) if (s.createdAt < cutoff) sessions.delete(k);
}, 1800000);

/* ════════════════════════════════════════════════════════════════
   ⏱️  RATE LIMITER — prevents Gemini 429 errors
   Free Gemini = 15 RPM per model. We cap at 12 to be safe.
════════════════════════════════════════════════════════════════ */
const RL = {
  calls: {},
  MAX: 12,
  canCall(m) {
    const now = Date.now();
    if (!this.calls[m]) this.calls[m] = [];
    this.calls[m] = this.calls[m].filter(t => now - t < 60000);
    return this.calls[m].length < this.MAX;
  },
  record(m) { if (!this.calls[m]) this.calls[m] = []; this.calls[m].push(Date.now()); },
  usage(m)  { const now=Date.now(); return (this.calls[m]||[]).filter(t=>now-t<60000).length; }
};

/* ════════════════════════════════════════════════════════════════
   🤖  GEMINI — 2 models = 30 RPM total free quota
   gemini-2.0-flash: 15 RPM (separate pool)
   gemini-1.5-flash: 15 RPM (separate pool)
   If one 429s → instantly switch to other!
════════════════════════════════════════════════════════════════ */
async function callGeminiModel(model, messages, system, maxTokens) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) throw new Error('NO_KEY');
  if (!RL.canCall(model)) throw new Error(`RATE_LIMIT:${model}:${RL.usage(model)}/min`);

  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = String(m.content || '').trim();
    if (!text) continue;
    if (contents.length && contents[contents.length-1].role === role)
      contents[contents.length-1].parts[0].text += '\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length || contents[0].role !== 'user')
    contents.unshift({ role:'user', parts:[{ text:'Hello' }] });

  const body = {
    contents,
    generationConfig: { maxOutputTokens: Math.min(maxTokens, 900), temperature: 0.8, topP: 0.95 }
  };
  if (system && system.trim())
    body.systemInstruction = { parts: [{ text: system.trim().slice(0, 800) }] };

  RL.record(model);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(18000) }
  );

  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`Gemini_${res.status}: ${err.slice(0,100)}`);
  }
  const data = await res.json();
  if (data.candidates?.[0]?.finishReason === 'SAFETY') throw new Error('SAFETY');
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.length < 4) throw new Error('EMPTY');
  return text.trim();
}

async function callGemini(messages, system, maxTokens) {
  for (const model of ['gemini-2.0-flash', 'gemini-1.5-flash']) {
    try {
      const text = await callGeminiModel(model, messages, system, maxTokens);
      console.log(`[Gemini ✅] ${model} rpm=${RL.usage(model)}`);
      return text;
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('429') || msg.includes('RATE_LIMIT')) {
        console.warn(`[Gemini ⚠️] ${model} rate limited → trying next model`);
      } else {
        console.warn(`[Gemini ⚠️] ${model}: ${msg.slice(0,60)}`);
      }
    }
  }
  throw new Error('All Gemini models failed');
}

/* ════════════════════════════════════════════════════════════════
   🌟  POLLINATIONS — ALL models race in PARALLEL
   Promise.any = first valid response wins, no sequential waiting!
════════════════════════════════════════════════════════════════ */
async function pollModel(model, messages, system, maxTokens, ms=13000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        model,
        messages: system ? [{role:'system',content:system.slice(0,500)}, ...messages] : messages,
        max_tokens: Math.min(maxTokens, 700),
        seed: Math.floor(Math.random()*9999)
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${model}-${res.status}`);
    const d = await res.json();
    const t = d.choices?.[0]?.message?.content;
    if (!t || t.length < 5) throw new Error('empty');
    return t.trim();
  } catch(e) { clearTimeout(timer); throw e; }
}

async function callPollinations(messages, system, maxTokens) {
  // Round 1: 4 models in parallel
  try {
    const result = await Promise.any([
      pollModel('openai-large', messages, system, maxTokens),
      pollModel('mistral',      messages, system, maxTokens),
      pollModel('openai',       messages, system, maxTokens),
      pollModel('llama',        messages, system, maxTokens),
    ]);
    console.log(`[Pollinations ✅] parallel`);
    return result;
  } catch(e) {}

  // Round 2: backup models
  try {
    const result = await Promise.any([
      pollModel('qwen-coder', messages, system, maxTokens),
      pollModel('phi',        messages, system, maxTokens),
    ]);
    return result;
  } catch(e) {
    throw new Error('All Pollinations failed');
  }
}

/* ════════════════════════════════════════════════════════════════
   📡  POST /api/ai
════════════════════════════════════════════════════════════════ */
app.post('/api/ai', async (req, res) => {
  try {
    const { messages=[], system='', max=1200, type='chat' } = req.body;
    if (!messages.length) return res.status(400).json({ error:'No messages' });

    const session = getOrCreateSession(req.headers['x-session-id']||'');
    res.setHeader('x-session-id', session.id);

    const key   = QUOTAS[type]!==undefined ? type : 'chat';
    const limit = QUOTAS[key];
    const used  = session.usage[key]||0;

    let text = null, ai = 'pollinations';

    if (used < limit) {
      try {
        text = await callGemini(messages, system, max);
        session.usage[key] = used + 1;
        ai = 'gemini';
      } catch(e) {
        console.warn(`[Gemini ❌] ${String(e.message).slice(0,80)} → Pollinations`);
      }
    } else {
      console.log(`[Quota 🔒] ${type} ${limit} reached → Pollinations`);
    }

    if (!text) {
      try {
        text = await callPollinations(messages, system, max);
      } catch(e) {
        console.error(`[Pollinations ❌] ${e.message}`);
        return res.json({ text:null, ai:'client-fallback', sessionId:session.id, remaining:buildRemaining(session) });
      }
    }

    return res.json({ text, ai, sessionId:session.id, remaining:buildRemaining(session) });

  } catch(err) {
    console.error('[Server Error]', err.message);
    res.status(500).json({ error:'Server error', message:err.message });
  }
});

function buildRemaining(s) {
  return {
    chat:   Math.max(0, QUOTAS.chat   - (s.usage.chat  ||0)),
    lesson: Math.max(0, QUOTAS.lesson - (s.usage.lesson||0)),
    visual: Math.max(0, QUOTAS.visual - (s.usage.visual||0)),
    coding: Math.max(0, QUOTAS.coding - (s.usage.coding||0)),
  };
}

app.get('/api/quota', (req, res) => {
  const s = getOrCreateSession(req.headers['x-session-id']||'');
  res.setHeader('x-session-id', s.id);
  res.json({ sessionId:s.id, remaining:buildRemaining(s), limits:QUOTAS });
});

app.get('/api/status', (_,res) => res.json({
  status:'ok', sessions:sessions.size,
  gemini: { '2.0-flash': RL.usage('gemini-2.0-flash')+'/12rpm', '1.5-flash': RL.usage('gemini-1.5-flash')+'/12rpm' }
}));

app.get('/health', (_,res) => res.json({ status:'ok', sessions:sessions.size }));

app.use(express.static(__dirname));
app.get('*', (req, res) => {
  const p = path.join(__dirname, 'MicroMind_v22.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#F5F3FF">
    <h1 style="color:#7C3AED">🧠 MicroMind Server v2 ✅</h1>
    <p>Upload MicroMind_v22.html to repo root.</p>
    <p style="color:#059669">Gemini: ${process.env.GEMINI_API_KEY?'✅ Key loaded':'❌ Key missing!'}</p>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 MicroMind Server v2 — port ${PORT}`);
  console.log(`📡 Gemini: ${process.env.GEMINI_API_KEY ? '✅ Key loaded' : '❌ KEY MISSING!'}`);
  console.log(`⚡ Dual Gemini: gemini-2.0-flash + gemini-1.5-flash = 30 RPM free`);
  console.log(`🌟 Pollinations: 6 models racing in parallel\n`);
});
