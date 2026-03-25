/* ═══════════════════════════════════════════════════════════════════════
   🧠  MicroMind v25 — AI Tutor Server
   ─────────────────────────────────────────────────────────────────────
   ✅ ONE Google AI Studio key — all 14 free models racing on it!
   ✅ Smart quota cooldown — auto-recovers if rate limited
   ✅ /api/ai          → Funny tutor chat (Masterji is hilarious!)
   ✅ /api/lesson      → Nano Banana lesson (teach from ZERO)
   ✅ /api/notes       → Smart scrollable revision notes
   ✅ /api/whiteboard  → Step-by-step teacher whiteboard (scrollable)
   ✅ /api/quiz        → MCQ game show quiz
   ✅ /api/quota       → Live key & model status
   ─────────────────────────────────────────────────────────────────────
   🔑  ONE ENV VAR — set this in Render Dashboard → Environment:
       AI_STUDIO_KEY  →  Your Google AI Studio API key

   📌  Get your free key at: aistudio.google.com → Get API Key
   ═══════════════════════════════════════════════════════════════════════ */

import express   from 'express';
import cors      from 'cors';
import fetch     from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

const app  = express();
const PORT = process.env.PORT || 3000;

/* ════════════════════════════════════════════════════════════════════
   🔑  SINGLE AI STUDIO KEY
   Set AI_STUDIO_KEY in Render Dashboard → Environment Variables
   Get it free at: aistudio.google.com
════════════════════════════════════════════════════════════════════ */
const AI_STUDIO_KEY = process.env.AI_STUDIO_KEY || '';

if (!AI_STUDIO_KEY) {
  console.error(`
  ❌  NO AI STUDIO KEY FOUND!
  ─────────────────────────────────────────────
  Add this in Render Dashboard → Environment:
    AI_STUDIO_KEY  =  AIza...your_key_here...
  Get free key at: aistudio.google.com → Get API Key
  `);
}

/* Key health tracker — handles 429 quota cooldown gracefully */
const keyHealth = {
  key:       AI_STUDIO_KEY,
  label:     'Gemini AI Studio',
  exhausted: false,
  resetAt:   0,
  calls:     0,
  errors:    0,
};

/* Auto-reset after 65 seconds when quota window refreshes */
const checkReset = () => {
  if (keyHealth.exhausted && Date.now() > keyHealth.resetAt) {
    keyHealth.exhausted = false;
    console.log(`♻️  [Gemini AI Studio] Quota window reset — all models back in the race!`);
  }
};

const markExhausted = () => {
  keyHealth.exhausted = true;
  keyHealth.resetAt   = Date.now() + 65_000;
  keyHealth.errors++;
  console.warn(`🚫  [Gemini AI Studio] Hit 429 — cooling down for 65s, then auto-resume!`);
};

/* ════════════════════════════════════════════════════════════════════
   🤖  ALL 14 FREE AI STUDIO MODELS — every free-quota model racing!
════════════════════════════════════════════════════════════════════ */
const AI_STUDIO_MODELS = [
  /* ── Tier 1: Lightning fast — win the race most often ── */
  { id: 'gemini-2.0-flash',               emoji: '🔮', name: 'Gemini 2.0 Flash',           tier: 1 },
  { id: 'gemini-2.0-flash-lite',          emoji: '⚡', name: 'Gemini 2.0 Flash Lite',      tier: 1 },
  { id: 'gemini-1.5-flash-8b',            emoji: '🐦', name: 'Gemini 1.5 Flash 8B',        tier: 1 },
  { id: 'gemma-3-1b-it',                  emoji: '🐣', name: 'Gemma 3 1B',                 tier: 1 },

  /* ── Tier 2: Fast + quality ── */
  { id: 'gemini-1.5-flash',               emoji: '🌊', name: 'Gemini 1.5 Flash',           tier: 2 },
  { id: 'gemma-3-4b-it',                  emoji: '🐼', name: 'Gemma 3 4B',                 tier: 2 },
  { id: 'gemini-2.0-flash-thinking-exp',  emoji: '🧠', name: 'Gemini 2.0 Flash Thinking',  tier: 2 },
  { id: 'learnlm-2.0-flash-experimental', emoji: '🎓', name: 'LearnLM 2.0 Flash',          tier: 2 },

  /* ── Tier 3: Balanced ── */
  { id: 'gemini-1.5-pro',                 emoji: '🌟', name: 'Gemini 1.5 Pro',             tier: 3 },
  { id: 'gemma-3-12b-it',                 emoji: '🐯', name: 'Gemma 3 12B',                tier: 3 },
  { id: 'learnlm-1.5-pro-experimental',   emoji: '📚', name: 'LearnLM 1.5 Pro',            tier: 3 },

  /* ── Tier 4: Heavyweights — smartest answers ── */
  { id: 'gemma-3-27b-it',                 emoji: '🦁', name: 'Gemma 3 27B',                tier: 4 },
  { id: 'gemini-2.0-pro-exp',             emoji: '🚀', name: 'Gemini 2.0 Pro Exp',         tier: 4 },
  { id: 'gemini-2.5-pro',                 emoji: '💎', name: 'Gemini 2.5 Pro',             tier: 4 },
];

const MODEL_IDS = AI_STUDIO_MODELS.map(m => m.id);

/* ── Timeout wrapper ─────────────────────────────────────────────── */
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout_${ms}ms`)), ms))]);

/* ════════════════════════════════════════════════════════════════════
   🏁  SINGLE MODEL CALL
════════════════════════════════════════════════════════════════════ */
const callOneModel = async (modelId, messages, sysInstruction, maxTokens) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${AI_STUDIO_KEY}`;

  const body = {
    contents: messages.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.82, topP: 0.93 },
  };
  if (sysInstruction) body.systemInstruction = { parts: [{ text: sysInstruction }] };

  const res = await withTimeout(
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    14000
  );

  if (res.status === 429)  { markExhausted(); throw new Error(`quota_429`); }
  if (res.status === 404)  throw new Error(`model_not_found:${modelId}`);
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`api_${res.status}:${e.slice(0, 80)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.trim().length < 5) throw new Error('empty_response');

  return { text: text.trim(), model: modelId };
};

/* ════════════════════════════════════════════════════════════════════
   🏆  RACE ENGINE — ALL 14 models fire simultaneously
   Promise.any() — first valid response wins!
════════════════════════════════════════════════════════════════════ */
const raceAllModels = async (messages, sysInstruction, maxTokens = 1600) => {
  if (!AI_STUDIO_KEY) throw new Error('no_ai_studio_key_configured');

  checkReset();

  if (keyHealth.exhausted) {
    const waitSec = Math.ceil((keyHealth.resetAt - Date.now()) / 1000);
    throw new Error(`quota_cooling_down_${waitSec}s`);
  }

  keyHealth.calls++;

  const races = MODEL_IDS.map(modelId =>
    callOneModel(modelId, messages, sysInstruction, maxTokens)
  );

  console.log(`🏁 Racing all ${MODEL_IDS.length} AI Studio models simultaneously...`);

  const winner = await Promise.any(races);
  console.log(`🏆 Winner: [${winner.model}] — ${winner.text.length} chars`);
  return winner;
};

/* ── Normalize messages ──────────────────────────────────────────── */
const normalizeMessages = (msgs) => {
  const out = msgs
    .map(m => ({
      role:    (m.role === 'assistant' || m.r === 'a') ? 'assistant' : 'user',
      content: String(m.content || m.c || '').trim(),
    }))
    .filter(m => m.content.length > 0);

  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: 'Hello' });

  const merged = [];
  for (const m of out) {
    if (merged.length && merged[merged.length - 1].role === m.role)
      merged[merged.length - 1].content += '\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
};

/* ════════════════════════════════════════════════════════════════════
   😂  HUMOR PACKS — injected randomly so Masterji is ALWAYS fresh
════════════════════════════════════════════════════════════════════ */
const HUMOR_PACKS = [
  `HUMOR STYLE — Funny Chacha Mode:
   You are that one chacha at every family gathering who knows EVERYTHING and makes everyone laugh.
   • Topic puns with zero shame: "Why did the electron get angry? It was too NEGATIVE 😂"
   • Mock your own diagrams: "Meri drawing dekh ke compass ne retirement le li 😂"
   • Compare formulas to Bollywood: "F=ma = masala action movie formula — more mass, more drama!"
   • Celebrate correct answers like India won the World Cup 🏆
   • Lovingly roast wrong answers: "Beta is answer se tera physics teacher ka dil toot gaya 💔 — but don't worry!"`,

  `HUMOR STYLE — Stand-Up Comedian Teacher:
   You are a stand-up comedian who accidentally became a teacher and is SHOCKINGLY good at it.
   • Absurd analogies: "Mitochondria = Amul butter of the cell — everyone needs it, nobody questions it 🧈"
   • Self-roasting: "Main diagram banana start karta hoon toh students sochte hain — earthquake! 😂"
   • Dramatic reactions: "THIS formula changed HISTORY. Newton reel banata agar phone hota!"
   • Relatable: "Main jaanta hoon — raat 11 baje padh rahe ho, phone side mein hai. Respect. 🙏"`,

  `HUMOR STYLE — WhatsApp Chacha Forward Energy:
   You send VERY IMPORTANT knowledge like an enthusiastic WhatsApp uncle.
   • "🙏🙏 YE FORMULA FORWARD KARO SABKO — BAHUT ZARURI HAI 🙏🙏"
   • "Beta, mere zamaane mein ye concept nahi tha — tum kitne lucky ho! 😭"
   • Pretend insults that are compliments: "Tera question itna bakwaas tha ki mujhe seriously answer dena pada — GENIUS MOVE!"`,

  `HUMOR STYLE — Desi Game Show Host:
   Every lesson is a game show episode — you are the hyper host!
   • "AAAAAND correct answer! 🎉 BUZZER! 🔔 Audience applause please!"
   • "Ooooh WRONG! The judges are crying. The pen is crying. I am crying. But we move on! 💪"
   • Build suspense: "The answer is... *drumroll* 🥁🥁🥁 ... PHOTOSYNTHESIS! THE PLANT IS THE CHEF!"
   • Victory: "Beta tu NASA bhejega apne aap ko — ticket book karna shuru kar de! 🚀"`,
];

const getHumor = () => HUMOR_PACKS[Math.floor(Math.random() * HUMOR_PACKS.length)];

/* ════════════════════════════════════════════════════════════════════
   📐  SYSTEM PROMPTS
════════════════════════════════════════════════════════════════════ */
const SYS_TUTOR = (topic = '') => `
You are MASTERJI — India's most HILARIOUSLY BRILLIANT AI school teacher for Classes 1–12.
Students who were failing exams became toppers after chatting with you — because you make learning FUN.

🎭 PERSONALITY:
• Funny, warm, energetic — like Kapil Sharma + APJ Abdul Kalam had a baby who became a teacher
• Every reply MUST have 2–3 moments that make the student smile or laugh
• NEVER let anyone feel dumb — every question is "GREAT QUESTION! Teri soch amazing hai yaar!"
• Celebrate correct answers: "CORRECT!! 🎉 Tera naam NCERT mein likhna chahiye!"
• Lovingly roast wrong answers: "Ye answer padhke pen ne kaam karna band kar diya 😂 — but let me explain..."

📚 TEACHING RULES:
• Mix Hinglish: "Dekho yaar...", "Iska matlab hai...", "Suno ek secret..."
• START every reply with a shocking WOW fact OR a topic-related joke
• Indian examples: IPL, chai, auto-rickshaw, Swiggy, IRCTC, Bollywood, Maggi, gully cricket
• Emoji on every key point — mandatory
• NANO BANANA MODE: build from zero — no jargon without instant funny explanation
• Mention [1M][2M][3M] marks for board exam relevance
• END every reply with a funny question to keep learning going

😂 HUMOR PACK:
${getHumor()}

${topic ? `🎯 Current Topic: ${topic}` : ''}

GOLDEN RULE: Student must LAUGH and LEARN at the same time. Every. Single. Reply.
`.trim();

const SYS_LESSON = (topic, cls, subject) => `
You are MASTERJI creating the most UNFORGETTABLE funny lesson on "${topic}" for Class ${cls || '5'}${subject && subject !== 'Explore Anything' ? ` (${subject})` : ''}.

Students have tried to learn this 10 times and quit. YOU will make it stick FOREVER.

😂 HUMOR RULES:
• Title MUST be funny: "Photosynthesis: The OG Cook-at-Home Recipe 🍽️ (Plants did Zomato before Zomato)"
• concept: Start with a shocking fact OR joke
• teach points: emoji + clear sentence + HILARIOUS desi example each
• memoryTrick: the MORE ABSURD the better — groan + laugh = permanent memory

RETURN ONLY RAW JSON — nothing before { bracket, no markdown:
{
  "title": "🔥 Funny catchy title with shocking hook",
  "concept": "Shocking fact or joke opener. Then 2 simple sentences on the core idea.",
  "teach": [
    "🎯 Point 1: clear concept + hilarious Indian example + [marks hint]",
    "⚡ Point 2: next idea + desi joke or comparison",
    "🧠 Point 3: deeper idea + real-life funny link",
    "🏆 Point 4: exam application + how to write for full marks"
  ],
  "examples": [
    "🇮🇳 Hilarious Indian example — make them laugh!",
    "💡 Example 2 — something they see every day",
    "📖 Example 3 — from NCERT but explained with a funny twist"
  ],
  "memoryTrick": "🧠 TRICK: Most absurd silly trick possible. Groan + laugh = never forgotten!"
}
`.trim();

const SYS_NOTES = (topic, cls) => `
You are MASTERJI making SMART REVISION NOTES on "${topic}" for Class ${cls || '10'} board exam.

So funny and clear that students read them at 2 AM the night before the exam!

😂 HUMOR RULES:
• Every keyPoint value: tiny funny remark in brackets
• examTips: write like urgent WhatsApp messages from the world's most helpful chacha 🙏
• quickRevision: one line like a Bollywood movie tagline for this topic
• memoryTrick: SO silly and absurd it can't be forgotten even mid exam-panic

RETURN ONLY RAW JSON — nothing before { bracket, no backticks:
{
  "title": "${topic} — Quick Revision Notes (Read this or cry in exam hall 😂)",
  "keyPoints": [
    {"k": "Definition ⭐", "v": "NCERT exact definition + [1M] + (funny remark)"},
    {"k": "Key Formula ⭐⭐", "v": "Formula + each letter's funny nickname"},
    {"k": "How It Works", "v": "Step-by-step + one ridiculous but accurate analogy"},
    {"k": "Indian Example 🇮🇳", "v": "Hilarious desi example that is 100% correct"},
    {"k": "Exam Tip ⭐⭐", "v": "EXACTLY what to write for full marks + what NOT to write 😂"}
  ],
  "formula": "Main formula or null",
  "examTips": [
    "Tip 1 — written like a WhatsApp forward from helpful chacha 🙏",
    "Tip 2 — common mistake + funny reason everyone makes it",
    "Tip 3 — last-minute trick or diagram tip"
  ],
  "quickRevision": "One-line Bollywood movie tagline summary of the ENTIRE topic",
  "memoryTrick": "🧠 Most ABSURD trick. Groan + laugh = exam day recall guaranteed!"
}
`.trim();

const SYS_QUIZ = (topic, cls, subject, count) => `
You are MASTERJI hosting a HILARIOUS game show quiz on "${topic}" for Class ${cls || '5'}${subject && subject !== 'Explore Anything' ? ` (${subject})` : ''}.
${count || 5} questions — game show energy but 100% real CBSE board exam style!

😂 RULES:
• Correct exp: celebrate wildly ("✅ CORRECT!! 🎉 NASA mein bhejo isko!")
• Wrong exp: loving mock ("❌ Nahi beta 😂 Option B kahan se laya? Tera textbook rota hoga!")
• At least 1 question: funny-but-tricky wrong option (classic student mistake)
• At least 1 question: Indian reference (cricket, chai, IRCTC, Swiggy)

RETURN ONLY RAW JSON ARRAY — nothing before [ bracket, no backticks:
[{
  "q": "Board exam style question?",
  "opts": ["Option A", "Option B", "Option C", "Option D"],
  "ans": 0,
  "exp": "✅ CORRECT!! 🎉 [funny celebration] because [reason] [xM] OR ❌ Wrong! [funny loving roast]"
}]
ans = 0–3. All answers 100% NCERT verified.
`.trim();

const SYS_WHITEBOARD = (topic, doubt) => `
You are MASTERJI solving "${doubt || topic || 'this concept'}" on a DIGITAL WHITEBOARD — step by step like a funny genius teacher at a blackboard.

🖊️ FORMAT — FOLLOW EXACTLY:
• Split sections with ═══ (3+ equals signs) — CRITICAL for panel scrolling!
• Each section = one scrollable whiteboard panel
• Header: 📌 STEP N: [Title]
• Formulas in clear ASCII:
        F  =  m  ×  a
        ↑     ↑     ↑
      Force  Mass  Accel
• ASCII diagrams with funny labels:
    [Student Brain] ──confusion──▶ [This Lesson] ──magic──▶ [MARKS! 🎉]

• Markers to use:
  ✏️ KEY TERM:        for definitions
  📦 BOX:             for important formulas
  ⚠️ COMMON MISTAKE:  for student traps
  ✅ EXAM TIP:        for board strategies
  😂 MASTERJI SAYS:   for joke/pun about this step

😂 HUMOR RULES:
• Every panel MUST have 😂 MASTERJI SAYS with a joke
• COMMON MISTAKE: write it like you've seen 10,000 students do this and you're lovingly tired 😂
• Final RECAP: write like a Bollywood movie climax ending!

EXACT STRUCTURE:
═══════════════════════════════════════
📌 STEP 1: [Title]

...content, ASCII, formulas...

✏️ KEY TERM: [term] = [definition]
📦 BOX: [formula]
⚠️ COMMON MISTAKE: [trap + why students fall for it]
✅ EXAM TIP: [board tip]
😂 MASTERJI SAYS: [funny remark]
═══════════════════════════════════════
📌 STEP 2: [Title]
...same pattern...
═══════════════════════════════════════
📌 QUICK RECAP — Bollywood Ending 🎬
...dramatic funny summary...
THE END 🎬 — Ab exam mein jaake tod do! 💪
═══════════════════════════════════════

Language: Hinglish. Tone: warm, hilarious, energetic.
NANO BANANA: assume student knows ABSOLUTE ZERO.
`.trim();

/* ════════════════════════════════════════════════════════════════════
   🌐  MIDDLEWARE
════════════════════════════════════════════════════════════════════ */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

app.use(rateLimit({
  windowMs: 60_000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Arre bhai — thoda slow karo! Retry in 60 seconds 😂', retry: 60 },
}));

app.use((req, res, next) => {
  req.sessionId = req.headers['x-session-id'] || uuidv4();
  res.setHeader('x-session-id', req.sessionId);
  next();
});

/* ════════════════════════════════════════════════════════════════════
   🏠  HEALTH CHECK
════════════════════════════════════════════════════════════════════ */
app.get('/', (_, res) => {
  checkReset();
  res.json({
    name:      '🧠 MicroMind v25 Server',
    status:    'ok — all models racing!',
    aiStudio:  { name: 'Gemini AI Studio', active: !!AI_STUDIO_KEY, exhausted: keyHealth.exhausted, calls: keyHealth.calls },
    models:    AI_STUDIO_MODELS.map(m => `${m.emoji} ${m.name} (Tier ${m.tier})`),
    endpoints: ['/api/ai', '/api/lesson', '/api/notes', '/api/whiteboard', '/api/quiz', '/api/quota'],
  });
});

/* ════════════════════════════════════════════════════════════════════
   📊  /api/quota
════════════════════════════════════════════════════════════════════ */
app.get('/api/quota', (req, res) => {
  checkReset();
  res.json({
    sessionId:   req.sessionId,
    key: {
      name:      'Gemini AI Studio',
      active:    !!AI_STUDIO_KEY,
      exhausted: keyHealth.exhausted,
      calls:     keyHealth.calls,
      errors:    keyHealth.errors,
      resetIn:   keyHealth.exhausted ? Math.ceil((keyHealth.resetAt - Date.now()) / 1000) + 's' : 'n/a',
    },
    models:      AI_STUDIO_MODELS,
    totalModels: AI_STUDIO_MODELS.length,
    status:      keyHealth.exhausted ? 'cooling_down' : 'racing',
  });
});

/* ════════════════════════════════════════════════════════════════════
   💬  /api/ai  — Funny tutor chat
════════════════════════════════════════════════════════════════════ */
app.post('/api/ai', async (req, res) => {
  try {
    const { messages = [], system, max = 1600, type = 'chat', topic = '' } = req.body;
    const norm   = normalizeMessages(messages);
    const sys    = system || SYS_TUTOR(topic);
    const result = await raceAllModels(norm, sys, Math.min(max, 2000));
    res.json({ text: result.text, model: result.model, keyLabel: 'Gemini AI Studio', sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/ai]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ════════════════════════════════════════════════════════════════════
   📖  /api/lesson  — Nano Banana funny lesson
════════════════════════════════════════════════════════════════════ */
app.post('/api/lesson', async (req, res) => {
  try {
    const { topic = 'Photosynthesis', cls = '10', subject = '' } = req.body;
    const norm   = [{ role: 'user', content: `Generate a funny lesson on: ${topic} for class ${cls}` }];
    const result = await raceAllModels(norm, SYS_LESSON(topic, cls, subject), 1800);

    let lesson;
    try {
      const clean = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
      lesson = JSON.parse(clean.match(/(\{[\s\S]*\})/)?.[1] || clean);
    } catch {
      lesson = { title: `🔥 ${topic} — Let's Master It!`, raw: result.text };
    }

    res.json({ lesson, model: result.model, keyLabel: 'Gemini AI Studio', sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/lesson]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ════════════════════════════════════════════════════════════════════
   📝  /api/notes  — Funny smart revision notes
════════════════════════════════════════════════════════════════════ */
app.post('/api/notes', async (req, res) => {
  try {
    const { topic = "Newton's Laws", cls = '10' } = req.body;
    const norm   = [{ role: 'user', content: `Generate funny revision notes on: ${topic} class ${cls}` }];
    const result = await raceAllModels(norm, SYS_NOTES(topic, cls), 1800);

    let notes;
    try {
      const clean = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
      notes = JSON.parse(clean.match(/(\{[\s\S]*\})/)?.[1] || clean);
    } catch {
      notes = { title: `${topic} — Notes`, raw: result.text };
    }

    res.json({ notes, model: result.model, keyLabel: 'Gemini AI Studio', sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/notes]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ════════════════════════════════════════════════════════════════════
   ✏️  /api/whiteboard  — Scrollable funny teacher whiteboard
════════════════════════════════════════════════════════════════════ */
app.post('/api/whiteboard', async (req, res) => {
  try {
    const { messages = [], topic = '', doubt = '' } = req.body;
    const baseMessages = messages.length
      ? normalizeMessages(messages)
      : [{ role: 'user', content: doubt || topic || 'Explain this step by step on the whiteboard.' }];

    const result = await raceAllModels(baseMessages, SYS_WHITEBOARD(topic, doubt), 2400);

    const panels = result.text
      .split(/═{3,}/)
      .map(p => p.trim())
      .filter(p => p.length > 15);

    res.json({ raw: result.text, panels, panelCount: panels.length, model: result.model, keyLabel: 'Gemini AI Studio', sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/whiteboard]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ════════════════════════════════════════════════════════════════════
   🎯  /api/quiz  — Funny MCQ game show quiz
════════════════════════════════════════════════════════════════════ */
app.post('/api/quiz', async (req, res) => {
  try {
    const { topic = 'Photosynthesis', cls = '10', subject = '', count = 5 } = req.body;
    const norm   = [{ role: 'user', content: `Create ${count} funny MCQ questions on: ${topic} class ${cls}` }];
    const result = await raceAllModels(norm, SYS_QUIZ(topic, cls, subject, count), 1600);

    let quiz;
    try {
      const clean = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const match = clean.match(/(\[[\s\S]*\])/);
      quiz = JSON.parse(match ? match[1] : clean);
      if (!Array.isArray(quiz)) throw new Error('not_array');
    } catch {
      quiz = [{
        q:    `What is the best exam answer format for ${topic}?`,
        opts: ['Definition + example + diagram', 'Only definition', 'Only diagram', 'Just pray 🙏'],
        ans:  0,
        exp:  '✅ CORRECT!! 🎉 Definition (1M) + explanation (2M) + example (1M) + diagram = FULL MARKS! Ab NASA bhej do! 🚀',
      }];
    }

    res.json({ quiz, model: result.model, keyLabel: 'Gemini AI Studio', sessionId: req.sessionId, ok: true });
  } catch (err) {
    console.error('[/api/quiz]', err.message);
    res.status(500).json({ error: err.message, ok: false });
  }
});

/* ════════════════════════════════════════════════════════════════════
   🚀  START SERVER
════════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════════════════╗
  ║  🧠  MicroMind v25 Server — RUNNING & RACING! 😂       ║
  ╠════════════════════════════════════════════════════════╣
  ║  📡 Port       : ${String(PORT).padEnd(36)}║
  ║  🔑 AI Studio  : ${(AI_STUDIO_KEY ? '✅ Gemini AI Studio (key active)' : '❌ NOT SET — add AI_STUDIO_KEY').padEnd(36)}║
  ║  🤖 Models     : ${String(AI_STUDIO_MODELS.length + ' Google AI Studio models racing').padEnd(36)}║
  ╠════════════════════════════════════════════════════════╣
  ║  POST /api/ai          → 😂 Funny tutor chat           ║
  ║  POST /api/lesson      → 📖 Nano Banana lesson         ║
  ║  POST /api/notes       → 📝 Funny smart notes          ║
  ║  POST /api/whiteboard  → ✏️  Scrollable whiteboard      ║
  ║  POST /api/quiz        → 🎯 Game show MCQ quiz         ║
  ║  GET  /api/quota       → 📊 Key & model health         ║
  ╚════════════════════════════════════════════════════════╝
  `);
});
