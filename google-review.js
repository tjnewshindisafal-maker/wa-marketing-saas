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

// ─── Core: WhatsApp message bhejo ────────────────────────────────────────────
async function sendReviewWA(sock, phone, name, settings, business) {
  const msg = (settings.messageTemplate || REVIEW_TEMPLATES.general)
    .replace(/\{name\}/g, name || 'Customer')
    .replace(/\{business\}/g, business || 'our business')
    .replace(/\{store\}/g, business || 'our business')
    .replace(/\{link\}/g,  settings.googleLink || '');
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: msg });
}

// ─── Register all routes ──────────────────────────────────────────────────────
function registerReviewRoutes(app, db, clientAuth, PLAN_FEATURES, sessions) {

  // Plan access check middleware
  function reviewAccess(req, res, next) {
    const features = PLAN_FEATURES[req.user.plan] || PLAN_FEATURES.starter;
    if (!features.reviews) {
      return res.json({ ok: false, msg: 'Google Review feature Pro plan (999) ya upar mein available hai.' });
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
        return res.json({ ok: false, msg: 'Sirf 10 AM - 8 PM ke beech messages bheje ja sakte hain.' });

      const { phone, name } = req.body;
      if (!phone) return res.json({ ok: false, msg: 'Phone number required hai.' });

      const settings = await getSettings(db, req.user._id, req.user.industry);
      if (!settings.googleLink)
        return res.json({ ok: false, msg: 'Pehle Settings mein Google Review link set karein.' });

      if (await isOnCooldown(db, req.user._id, phone, settings.cooldownDays))
        return res.json({ ok: false, msg: `Is customer ko ${settings.cooldownDays} din mein already request bheji ja chuki hai.` });

      const todayCount = await todaySentCount(db, req.user._id);
      if (todayCount >= settings.dailyLimit)
        return res.json({ ok: false, msg: `Aaj ka limit (${settings.dailyLimit}) poora ho gaya.` });

      const s = sessions[req.user._id.toString()];
      if (!s || s.status !== 'connected')
        return res.json({ ok: false, msg: 'WhatsApp connected nahi hai. Pehle QR scan karein.' });

      const businessName = req.user.business || req.user.name || 'our business';
      await sendReviewWA(s.sock, phone, name, settings, businessName);
      await db.collection('review_logs').insertOne({
        userId: req.user._id.toString(), phone, customerName: name || '',
        status: 'sent', sentAt: new Date()
      });
      res.json({ ok: true, msg: 'Review request bheji gayi!' });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // POST bulk via Excel
  app.post('/api/review/send-bulk', clientAuth, reviewAccess, reviewUpload.single('file'), async (req, res) => {
    try {
      if (!isAllowedTime())
        return res.json({ ok: false, msg: 'Sirf 10 AM - 8 PM ke beech messages bheje ja sakte hain.' });

      if (!req.file) return res.json({ ok: false, msg: 'Excel file required hai.' });

      const settings = await getSettings(db, req.user._id, req.user.industry);
      if (!settings.googleLink)
        return res.json({ ok: false, msg: 'Pehle Settings mein Google Review link set karein.' });

      const s = sessions[req.user._id.toString()];
      if (!s || s.status !== 'connected')
        return res.json({ ok: false, msg: 'WhatsApp connected nahi hai.' });

      const businessName = req.user.business || req.user.name || 'our business';

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = XLSX.utils.sheet_to_json(sheet);

      let sent = 0, skipped = 0, failed = 0;

      for (const row of rows) {
        const phone = String(row['Phone'] || row['phone'] || row['Mobile'] || row['mobile'] || '').trim();
        const name  = String(row['Name']  || row['name']  || row['Customer'] || '').trim();
        if (!phone) { skipped++; continue; }

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
