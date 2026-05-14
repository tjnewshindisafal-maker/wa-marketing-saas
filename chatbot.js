// ============================================================
// chatbot.js — WA Marketing SaaS
// Three-tier auto-reply engine: Flow → Keyword → AI (Gemini)
// Har client ka apna bot config hoga
// ============================================================

const { ObjectId } = require('mongodb');

// ── In-memory active flow sessions (lost on restart, intentional) ────────────
// activeSessions[userId][phone] = { flowId, stepId, lastActivity }
const activeSessions = {};

// ── Normalize Indian phone number (same as google-review.js) ────────────────
function normalizePhone(phone) {
  let ph = String(phone || '').replace(/\D/g, '');
  if (ph.length === 11 && ph.startsWith('0')) ph = ph.slice(1);
  if (ph.length === 10) ph = '91' + ph;
  return ph;
}

// ── Get chatbot config for a user (with sensible defaults) ──────────────────
async function getConfig(db, userId) {
  const config = await db.collection('chatbot_config').findOne({ userId: userId.toString() });
  return config || {
    enabled: false,
    greetingMsg: 'Hi! 👋 How can I help you today? Type *menu* for options.',
    fallbackMsg: "Sorry, I didn't understand that. 🤔 Type *menu* for options.",
    aiEnabled: false,
    aiContext: '',
    autoFlowId: null,
    triggerWords: ['hi', 'hello', 'hey', 'menu', 'start', 'help', 'hii', 'namaste']
  };
}

// ── Flow session helpers ─────────────────────────────────────────────────────
function getSession(userId, phone) {
  const s = activeSessions[userId]?.[phone];
  if (!s) return null;
  // 30-minute inactivity timeout
  if (Date.now() - s.lastActivity > 30 * 60 * 1000) {
    delete activeSessions[userId][phone];
    return null;
  }
  return s;
}

function setSession(userId, phone, data) {
  if (!activeSessions[userId]) activeSessions[userId] = {};
  activeSessions[userId][phone] = { ...data, lastActivity: Date.now() };
}

function clearSession(userId, phone) {
  if (activeSessions[userId]) delete activeSessions[userId][phone];
}

// ── AI reply via Gemini ──────────────────────────────────────────────────────
async function getAIReply(userMessage, config, businessName, industry) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const context = config.aiContext ||
    `You are a helpful WhatsApp assistant for ${businessName}, a ${industry || 'general'} business.`;

  const prompt = `${context}

Customer message: "${userMessage}"

Reply in a short, friendly WhatsApp message (max 3 sentences). Use simple language. You can use *bold* for emphasis. If you don't know the answer, say "Please contact us directly for more info."

Return ONLY the reply message. No explanation.`;

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
  ].filter(Boolean);

  for (const model of modelsToTry) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 150 }
          })
        }
      );
      const data = await r.json();
      if (data.error) {
        if (/not found|NOT_FOUND/i.test(data.error.message || '')) continue;
        break;
      }
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
      if (text) return text;
    } catch (e) { /* try next model */ }
  }
  return null;
}

// ── Core engine: handle one incoming WA message ──────────────────────────────
async function handleIncomingMessage(db, userId, fromJid, messageText, sock, userData) {
  try {
    const config = await getConfig(db, userId);
    if (!config.enabled) return;

    const phone = fromJid.replace('@s.whatsapp.net', '');
    const text = (messageText || '').trim();
    if (!text) return;

    const textLower = text.toLowerCase();
    const businessName = userData?.business || userData?.name || 'our business';
    const industry = userData?.industry || 'general';

    // Log incoming message
    await db.collection('chatbot_logs').insertOne({
      userId: userId.toString(), phone,
      direction: 'in', message: text, timestamp: new Date()
    });

    let reply = null;

    // ── Tier 1: Active flow session ────────────────────────────────────
    const flowSession = getSession(userId, phone);
    if (flowSession) {
      try {
        const flow = await db.collection('chatbot_flows').findOne({
          _id: new ObjectId(flowSession.flowId),
          userId: userId.toString()
        });
        if (flow) {
          const step = flow.steps.find(s => s.id === flowSession.stepId);
          if (step?.options?.length > 0) {
            const chosen = step.options.find(o => o.input.toLowerCase() === textLower);
            if (chosen) {
              reply = chosen.reply || '';
              if (chosen.nextStep) {
                const next = flow.steps.find(s => s.id === chosen.nextStep);
                if (next) {
                  reply = (reply ? reply + '\n\n' : '') + next.message;
                  if (next.options?.length > 0) {
                    setSession(userId, phone, { flowId: flowSession.flowId, stepId: next.id });
                  } else {
                    clearSession(userId, phone);
                  }
                }
              } else {
                clearSession(userId, phone);
              }
            } else {
              const optionList = step.options.map(o => `*${o.input}.* ${o.label || o.input}`).join('\n');
              reply = `Please choose a valid option:\n\n${optionList}`;
            }
          }
        }
      } catch (e) { clearSession(userId, phone); }
    }

    // ── Tier 2a: Trigger word → start flow ────────────────────────────
    if (!reply) {
      const triggerWords = config.triggerWords || ['hi', 'hello', 'hey', 'menu', 'start'];
      const isTriggered = triggerWords.some(w => textLower === w.toLowerCase() || textLower.startsWith(w.toLowerCase()));

      if (isTriggered && config.autoFlowId) {
        try {
          const flow = await db.collection('chatbot_flows').findOne({
            _id: new ObjectId(config.autoFlowId),
            userId: userId.toString()
          });
          if (flow?.steps?.length > 0) {
            const first = flow.steps[0];
            reply = first.message;
            if (first.options?.length > 0) {
              setSession(userId, phone, { flowId: config.autoFlowId, stepId: first.id });
            }
          }
        } catch (e) { /* invalid flow id, fall through */ }
      } else if (isTriggered) {
        reply = config.greetingMsg;
      }
    }

    // ── Tier 2b: Keyword matching ──────────────────────────────────────
    if (!reply) {
      const keywords = await db.collection('chatbot_keywords')
        .find({ userId: userId.toString(), isActive: true })
        .toArray();

      for (const kw of keywords) {
        const kw_lower = kw.keyword.toLowerCase();
        let matched = false;
        if (kw.matchType === 'exact')       matched = textLower === kw_lower;
        else if (kw.matchType === 'starts') matched = textLower.startsWith(kw_lower);
        else                                matched = textLower.includes(kw_lower); // contains
        if (matched) { reply = kw.reply; break; }
      }
    }

    // ── Tier 3: AI fallback ────────────────────────────────────────────
    if (!reply && config.aiEnabled) {
      reply = await getAIReply(text, config, businessName, industry);
    }

    // ── Default fallback ───────────────────────────────────────────────
    if (!reply) {
      reply = config.fallbackMsg || "Sorry, I didn't understand. Type *menu* for options.";
    }

    // Send reply
    await sock.sendMessage(fromJid, { text: reply });

    // Log outgoing
    await db.collection('chatbot_logs').insertOne({
      userId: userId.toString(), phone,
      direction: 'out', message: reply, timestamp: new Date()
    });

  } catch (e) {
    console.log('Chatbot error:', e.message);
  }
}

// ── Register all API routes ──────────────────────────────────────────────────
function registerChatbotRoutes(app, db, clientAuth, PLAN_FEATURES) {

  function chatbotAccess(req, res, next) {
    const features = PLAN_FEATURES[req.user.plan] || PLAN_FEATURES.starter;
    if (!features.chatbot) {
      return res.json({ ok: false, msg: 'Chatbot feature is available on Pro plan (₹999) and above.' });
    }
    next();
  }

  // ── Config ────────────────────────────────────────────────────────────────
  app.get('/api/chatbot/config', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const config = await getConfig(db, req.user._id);
      res.json({ ok: true, config });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.post('/api/chatbot/config', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const { enabled, greetingMsg, fallbackMsg, aiEnabled, aiContext, autoFlowId, triggerWords } = req.body;
      const update = {
        enabled: !!enabled,
        greetingMsg: greetingMsg || '',
        fallbackMsg: fallbackMsg || '',
        aiEnabled: !!aiEnabled,
        aiContext: aiContext || '',
        autoFlowId: autoFlowId || null,
        triggerWords: Array.isArray(triggerWords) ? triggerWords : (triggerWords || '').split(',').map(w => w.trim()).filter(Boolean),
        updatedAt: new Date()
      };
      await db.collection('chatbot_config').updateOne(
        { userId: req.user._id.toString() },
        { $set: update },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // ── Keywords ──────────────────────────────────────────────────────────────
  app.get('/api/chatbot/keywords', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const keywords = await db.collection('chatbot_keywords')
        .find({ userId: req.user._id.toString() })
        .sort({ createdAt: -1 }).toArray();
      res.json({ ok: true, keywords });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.post('/api/chatbot/keywords', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const { keyword, reply, matchType } = req.body;
      if (!keyword?.trim() || !reply?.trim())
        return res.json({ ok: false, msg: 'Keyword and reply are required.' });
      await db.collection('chatbot_keywords').insertOne({
        userId: req.user._id.toString(),
        keyword: keyword.trim().toLowerCase(),
        reply: reply.trim(),
        matchType: matchType || 'contains',
        isActive: true,
        createdAt: new Date()
      });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.put('/api/chatbot/keywords/:id', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const { keyword, reply, matchType, isActive } = req.body;
      const update = {};
      if (keyword !== undefined)   update.keyword   = keyword.trim().toLowerCase();
      if (reply !== undefined)     update.reply     = reply.trim();
      if (matchType !== undefined) update.matchType = matchType;
      if (isActive !== undefined)  update.isActive  = isActive;
      await db.collection('chatbot_keywords').updateOne(
        { _id: new ObjectId(req.params.id), userId: req.user._id.toString() },
        { $set: update }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.delete('/api/chatbot/keywords/:id', clientAuth, chatbotAccess, async (req, res) => {
    try {
      await db.collection('chatbot_keywords').deleteOne({
        _id: new ObjectId(req.params.id), userId: req.user._id.toString()
      });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // ── Flows ─────────────────────────────────────────────────────────────────
  app.get('/api/chatbot/flows', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const flows = await db.collection('chatbot_flows')
        .find({ userId: req.user._id.toString() })
        .sort({ createdAt: -1 }).toArray();
      res.json({ ok: true, flows });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.post('/api/chatbot/flows', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const { name, steps } = req.body;
      if (!name?.trim() || !steps?.length)
        return res.json({ ok: false, msg: 'Flow name and at least one step are required.' });
      const result = await db.collection('chatbot_flows').insertOne({
        userId: req.user._id.toString(),
        name: name.trim(),
        steps,
        createdAt: new Date()
      });
      res.json({ ok: true, id: result.insertedId });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.put('/api/chatbot/flows/:id', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const { name, steps } = req.body;
      const update = { updatedAt: new Date() };
      if (name)  update.name  = name.trim();
      if (steps) update.steps = steps;
      await db.collection('chatbot_flows').updateOne(
        { _id: new ObjectId(req.params.id), userId: req.user._id.toString() },
        { $set: update }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.delete('/api/chatbot/flows/:id', clientAuth, chatbotAccess, async (req, res) => {
    try {
      await db.collection('chatbot_flows').deleteOne({
        _id: new ObjectId(req.params.id), userId: req.user._id.toString()
      });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // ── Logs ──────────────────────────────────────────────────────────────────
  app.get('/api/chatbot/logs', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const filter = { userId: req.user._id.toString() };
      if (req.query.phone) filter.phone = normalizePhone(req.query.phone);
      const logs = await db.collection('chatbot_logs')
        .find(filter).sort({ timestamp: -1 }).limit(200).toArray();
      res.json({ ok: true, logs });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  app.get('/api/chatbot/stats', clientAuth, chatbotAccess, async (req, res) => {
    try {
      const uid = req.user._id.toString();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [todayMsgs, uniquePhones] = await Promise.all([
        db.collection('chatbot_logs').countDocuments({ userId: uid, timestamp: { $gte: today } }),
        db.collection('chatbot_logs').distinct('phone', { userId: uid })
      ]);
      const activeCount = activeSessions[uid] ? Object.keys(activeSessions[uid]).length : 0;
      res.json({ ok: true, todayMsgs, totalConversations: uniquePhones.length, activeCount });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  console.log('Chatbot routes registered');
}

module.exports = { registerChatbotRoutes, handleIncomingMessage };
