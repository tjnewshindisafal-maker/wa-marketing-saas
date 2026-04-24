// ============================================================
// google-review.js — WA Marketing SaaS
// Native MongoDB driver use karta hai (NO mongoose)
// Server.js ka db object pass hoga — koi extra dependency nahi
// ============================================================

const multer = require('multer');
const XLSX   = require('xlsx');
const path   = require('path');

// ─── Multer (memory storage — server.js wala diskStorage alag hai) ────────────
const reviewUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('Only Excel/CSV files allowed'));
  },
  limits: { fileSize: 2 * 1024 * 1024 }
});

// ─── Helper: IST time window check (10AM - 8PM) ───────────────────────────────
function isAllowedTime() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h   = ist.getHours();
  return h >= 10 && h < 20;
}

// ─── Helper: Random delay 30-90 sec ──────────────────────────────────────────
function randomDelay() {
  return new Promise(r => setTimeout(r, (30 + Math.floor(Math.random() * 61)) * 1000));
}

// ─── Helper: Cooldown check ───────────────────────────────────────────────────
async function isOnCooldown(db, userId, phone, cooldownDays = 30) {
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
  const found  = await db.collection('review_logs').findOne({
    userId: userId.toString(), phone,
    sentAt: { $gte: cutoff }, status: 'sent'
  });
  return !!found;
}

// ─── Helper: Today's sent count ───────────────────────────────────────────────
async function todaySentCount(db, userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.collection('review_logs').countDocuments({
    userId: userId.toString(),
    sentAt: { $gte: start },
    status: 'sent'
  });
}

// ─── Professional English templates (anti-spam, personalized) ────────────────
const REVIEW_TEMPLATES = {
  salon: `Hi {name}, hope you had a great experience at {business}! 💇

If you enjoyed your visit, a quick Google review would mean the world to our team.

{link}

Thank you so much!
— Team {business}`,

  clinic: `Dear {name}, thank you for choosing {business} for your care.

If you were satisfied with our service, we would truly appreciate a short Google review from you.

{link}

Your feedback helps others find quality healthcare.
— {business}`,

  auto: `Hi {name}, thanks for trusting {business} with your vehicle! 🚗

If everything went well, would you mind sharing a quick Google review?

{link}

It really helps our team. Appreciate it!
— {business}`,

  repair: `Hi {name}, thank you for choosing {business} for the repair service! 🔧

If you're happy with the work, a quick Google review would help us a lot.

{link}

Thanks for your support!
— Team {business}`,

  food: `Hi {name}, thank you for ordering from {business}! 🍽️

Hope you enjoyed the meal. If you did, a short Google review would make our day.

{link}

Thanks a lot!
— {business}`,

  retail: `Hi {name}, thank you for shopping with {business}!

If you had a great experience, we would love a quick Google review from you.

{link}

Your support means a lot to our small business.
— Team {business}`,

  gym: `Hi {name}, thanks for being part of {business}! 💪

If you're enjoying your fitness journey with us, a Google review would really help.

{link}

Keep going strong!
— Team {business}`,

  general: `Hi {name}, thank you for choosing {business}!

If you had a good experience, a quick Google review would mean a lot to our team.

{link}

Thanks for your support!
— {business}`
};

function getTemplateForIndustry(industry){
  const map = {
    salon: 'salon', beauty: 'salon',
    clinic: 'clinic', doctor: 'clinic', hospital: 'clinic', dental: 'clinic',
    auto: 'auto', carwash: 'auto', garage: 'auto',
    repair: 'repair', electric: 'repair',
    food: 'food', restaurant: 'food', bakery: 'food', cafe: 'food',
    retail: 'retail', shop: 'retail', ecom: 'retail', store: 'retail',
    gym: 'gym', fitness: 'gym', coaching: 'gym',
  };
  const key = map[industry] || 'general';
  return REVIEW_TEMPLATES[key];
}

// ─── Helper: Get user settings ───────────────────────────────────────────────
async function getSettings(db, userId, userIndustry) {
  const s = await db.collection('review_settings').findOne({ userId: userId.toString() });
  if(s) return s;

  // Return sensible default based on user's industry
  return {
    userId: userId.toString(),
    googleLink: '',
    messageTemplate: getTemplateForIndustry(userIndustry || 'general'),
    autoOnJobComplete: false,
    dailyLimit: 20,
    cooldownDays: 30
  };
}

// ─── Helper: Normalize Indian phone number ───────────────────────────────────
function normalizePhone(phone){
  let ph = String(phone || '').replace(/\D/g, ''); // strip non-digits
  // Remove leading 0 (common local format): 08087289267 → 8087289267
  if(ph.length === 11 && ph.startsWith('0')) ph = ph.slice(1);
  // Add 91 if 10-digit number
  if(ph.length === 10) ph = '91' + ph;
  return ph;
}

// ─── Core: WhatsApp message bhejo ────────────────────────────────────────────
async function sendReviewWA(sock, phone, name, settings, business) {
  const msg = (settings.messageTemplate || REVIEW_TEMPLATES.general)
    .replace(/\{name\}/g, name || 'Customer')
    .replace(/\{business\}/g, business || 'our business')
    .replace(/\{store\}/g, business || 'our business')
    .replace(/\{link\}/g,  settings.googleLink || '');
  const ph = normalizePhone(phone);
  if(ph.length < 11) throw new Error('Invalid phone number format');
  const jid = ph + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: msg });
}

// ─── Register all routes ──────────────────────────────────────────────────────
function registerReviewRoutes(app, db, clientAuth, PLAN_FEATURES, sessions) {

  // Plan access check middleware
  function reviewAccess(req, res, next) {
    const features = PLAN_FEATURES[req.user.plan] || PLAN_FEATURES.starter;
    if (!features.reviews) {
      return res.json({ ok: false, msg: 'Google Review feature is available on Pro plan (₹999) and above.' });
    }
    next();
  }

  // GET settings
  app.get('/api/review/settings', clientAuth, reviewAccess, async (req, res) => {
    try {
      const s = await getSettings(db, req.user._id, req.user.industry);
      res.json({ ok: true, settings: s });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // GET all available templates (for "Choose Template" dropdown)
  app.get('/api/review/templates', clientAuth, reviewAccess, async (req, res) => {
    try {
      res.json({ ok: true, templates: REVIEW_TEMPLATES });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // POST generate message with AI (Gemini free tier)
  app.post('/api/review/generate', clientAuth, reviewAccess, async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.json({ ok: false, msg: 'AI not configured. Admin needs to set GEMINI_API_KEY.' });
      }
      const industry = (req.body.industry || req.user.industry || 'general').toLowerCase();
      const tone = (req.body.tone || 'friendly').toLowerCase();
      const language = (req.body.language || 'english').toLowerCase();
      const businessName = req.user.business || req.user.name || 'our business';

      const prompt = `Write a short, polite WhatsApp message (max 4 lines) asking a customer to leave a Google review.
Industry: ${industry}
Business name: ${businessName}
Tone: ${tone}
Language: ${language}

Requirements:
- Use these placeholders exactly: {name} for customer name, {business} for business name, {link} for Google review link
- Keep under 50 words
- Natural conversational tone (not spammy)
- One emoji max
- End with a brief thank you
- No "FREE", "URGENT", "CLICK NOW" type spam words

Return ONLY the message text. No explanation, no quotes, no markdown.`;

      // Try multiple models in order (newest first). Gemini deprecates models often.
      const modelsToTry = [
        process.env.GEMINI_MODEL,       // override via env if set
        'gemini-2.5-flash',             // current stable free tier (as of 2026)
        'gemini-2.5-flash-lite',        // fallback: lighter/faster
        'gemini-2.0-flash',             // older fallback (deprecating June 2026)
      ].filter(Boolean);

      let data = null;
      let lastErr = '';
      for (const model of modelsToTry) {
        try {
          const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.8, maxOutputTokens: 200 }
            })
          });
          data = await r.json();
          if (!data.error) break; // success
          lastErr = data.error.message || 'Unknown';
          // If model not found, try next one; for other errors, stop
          if (!/not found|not supported|NOT_FOUND/i.test(lastErr)) break;
        } catch(e){ lastErr = e.message; }
      }
      if (!data || data.error) {
        return res.json({ ok: false, msg: 'AI error: ' + (lastErr || 'failed') });
      }
      const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
        ? data.candidates[0].content.parts.map(p => p.text).join('').trim()
        : '';
      if (!text) return res.json({ ok: false, msg: 'AI returned empty response. Try again.' });

      // Ensure {link} is present (sometimes model drops it)
      let finalText = text;
      if (!/\{link\}/i.test(finalText)) finalText += '\n\n{link}';

      res.json({ ok: true, message: finalText });
    } catch (e) {
      res.json({ ok: false, msg: 'Generate failed: ' + e.message });
    }
  });

  // POST save settings
  app.post('/api/review/settings', clientAuth, reviewAccess, async (req, res) => {
    try {
      const { googleLink, messageTemplate, autoOnJobComplete } = req.body;
      await db.collection('review_settings').updateOne(
        { userId: req.user._id.toString() },
        { $set: { googleLink, messageTemplate, autoOnJobComplete, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // GET stats
  app.get('/api/review/stats', clientAuth, reviewAccess, async (req, res) => {
    try {
      const settings   = await getSettings(db, req.user._id, req.user.industry);
      const todayCount = await todaySentCount(db, req.user._id);
      const totalSent  = await db.collection('review_logs').countDocuments({ userId: req.user._id.toString(), status: 'sent' });
      res.json({ ok: true, todayCount, totalSent, dailyLimit: settings.dailyLimit, googleLink: settings.googleLink });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // POST send single
  app.post('/api/review/send-single', clientAuth, reviewAccess, async (req, res) => {
    try {
      if (!isAllowedTime())
        return res.json({ ok: false, msg: 'Messages can only be sent between 10 AM and 8 PM.' });

      let { phone, name } = req.body;
      if (!phone) return res.json({ ok: false, msg: 'Phone number is required.' });

      // Normalize phone early so cooldown/logs match
      phone = normalizePhone(phone);
      if (phone.length < 11)
        return res.json({ ok: false, msg: 'Invalid phone number. Use 10-digit Indian number or with 91 country code.' });

      const settings = await getSettings(db, req.user._id, req.user.industry);
      if (!settings.googleLink)
        return res.json({ ok: false, msg: 'Please set your Google Review link in Settings first.' });

      if (await isOnCooldown(db, req.user._id, phone, settings.cooldownDays))
        return res.json({ ok: false, msg: `This customer has already received a request in the last ${settings.cooldownDays} days.` });

      const todayCount = await todaySentCount(db, req.user._id);
      if (todayCount >= settings.dailyLimit)
        return res.json({ ok: false, msg: `Daily limit (${settings.dailyLimit}) reached.` });

      const s = sessions[req.user._id.toString()];
      if (!s || s.status !== 'connected')
        return res.json({ ok: false, msg: 'WhatsApp is not connected. Please scan the QR code first.' });

      const businessName = req.user.business || req.user.name || 'our business';
      try {
        await sendReviewWA(s.sock, phone, name, settings, businessName);
      } catch(sendErr){
        await db.collection('review_logs').insertOne({
          userId: req.user._id.toString(), phone, customerName: name || '',
          status: 'failed', skipReason: sendErr.message, sentAt: new Date()
        });
        return res.json({ ok: false, msg: 'Failed to send message: ' + sendErr.message });
      }
      await db.collection('review_logs').insertOne({
        userId: req.user._id.toString(), phone, customerName: name || '',
        status: 'sent', sentAt: new Date()
      });
      res.json({ ok: true, msg: 'Review request sent!' });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // POST bulk via Excel
  app.post('/api/review/send-bulk', clientAuth, reviewAccess, reviewUpload.single('file'), async (req, res) => {
    try {
      if (!isAllowedTime())
        return res.json({ ok: false, msg: 'Messages can only be sent between 10 AM and 8 PM.' });

      if (!req.file) return res.json({ ok: false, msg: 'Excel file is required.' });

      const settings = await getSettings(db, req.user._id, req.user.industry);
      if (!settings.googleLink)
        return res.json({ ok: false, msg: 'Please set your Google Review link in Settings first.' });

      const s = sessions[req.user._id.toString()];
      if (!s || s.status !== 'connected')
        return res.json({ ok: false, msg: 'WhatsApp is not connected.' });

      const businessName = req.user.business || req.user.name || 'our business';

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = XLSX.utils.sheet_to_json(sheet);

      let sent = 0, skipped = 0, failed = 0;

      for (const row of rows) {
        let phone = String(row['Phone'] || row['phone'] || row['Mobile'] || row['mobile'] || '').trim();
        const name  = String(row['Name']  || row['name']  || row['Customer'] || '').trim();
        if (!phone) { skipped++; continue; }

        // Normalize phone
        phone = normalizePhone(phone);
        if (phone.length < 11) { skipped++; continue; }

        const todayCount = await todaySentCount(db, req.user._id);
        if (todayCount >= settings.dailyLimit) { skipped++; break; }

        if (await isOnCooldown(db, req.user._id, phone, settings.cooldownDays)) {
          await db.collection('review_logs').insertOne({
            userId: req.user._id.toString(), phone, customerName: name,
            status: 'skipped', skipReason: 'Cooldown', sentAt: new Date()
          });
          skipped++; continue;
        }

        try {
          await sendReviewWA(s.sock, phone, name, settings, businessName);
          await db.collection('review_logs').insertOne({
            userId: req.user._id.toString(), phone, customerName: name,
            status: 'sent', sentAt: new Date()
          });
          sent++;
          await randomDelay();
        } catch (err) {
          await db.collection('review_logs').insertOne({
            userId: req.user._id.toString(), phone, customerName: name,
            status: 'failed', skipReason: err.message, sentAt: new Date()
          });
          failed++;
        }
      }

      res.json({ ok: true, sent, skipped, failed });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // GET logs
  app.get('/api/review/logs', clientAuth, reviewAccess, async (req, res) => {
    try {
      const logs = await db.collection('review_logs')
        .find({ userId: req.user._id.toString() })
        .sort({ sentAt: -1 })
        .limit(100)
        .toArray();
      res.json({ ok: true, logs });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  console.log('Google Review routes registered');
}

// ─── Auto-trigger on Job Complete (optional) ─────────────────────────────────
// Server.js mein job status 'completed' hone par yeh call karo:
// triggerReviewOnJobComplete(db, sessions, userId, phone, customerName)
async function triggerReviewOnJobComplete(db, sessions, userId, phone, customerName) {
  try {
    const settings = await db.collection('review_settings').findOne({ userId: userId.toString() });
    if (!settings || !settings.autoOnJobComplete || !settings.googleLink) return;
    if (!isAllowedTime()) return;

    const todayCount = await todaySentCount(db, userId);
    if (todayCount >= (settings.dailyLimit || 20)) return;
    if (await isOnCooldown(db, userId, phone, settings.cooldownDays || 30)) return;

    const s = sessions[userId.toString()];
    if (!s || s.status !== 'connected') return;

    // Fetch business name for personalization
    const { ObjectId } = require('mongodb');
    let businessName = 'our business';
    try {
      const user = await db.collection('users').findOne({ _id: new ObjectId(userId.toString()) });
      if (user) businessName = user.business || user.name || 'our business';
    } catch(e){}

    await sendReviewWA(s.sock, phone, customerName, settings, businessName);
    await db.collection('review_logs').insertOne({
      userId: userId.toString(), phone, customerName: customerName || '',
      status: 'sent', sentAt: new Date()
    });
    console.log('Auto review sent to', phone);
  } catch (e) {
    console.log('Auto review error:', e.message);
  }
}

module.exports = { registerReviewRoutes, triggerReviewOnJobComplete };
