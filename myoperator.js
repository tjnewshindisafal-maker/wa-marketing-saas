// ============================================================
// myoperator.js — MyOperator official WhatsApp Business API integration
// Lets an individual client route their bulk WhatsApp sends through
// their own MyOperator account instead of the QR-based Baileys session.
// Kept as a standalone module so server.js only needs a few small hooks.
// ============================================================

function sanitize(s, maxLen) {
  if (!s) return '';
  return String(s).trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function normalizeNumber(phone) {
  let ph = String(phone || '').replace(/\D/g, '');
  if (ph.length === 11 && ph.startsWith('0')) ph = ph.slice(1);
  if (ph.length > 10) {
    return { countryCode: ph.slice(0, ph.length - 10), number: ph.slice(-10) };
  }
  return { countryCode: '91', number: ph };
}

async function sendTextMessage(cfg, phone, text) {
  const { countryCode, number } = normalizeNumber(phone);
  const resp = await fetch((cfg.baseUrl || 'https://publicapi.myoperator.co') + '/chat/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey,
      'X-MYOP-COMPANY-ID': cfg.companyId
    },
    body: JSON.stringify({
      phone_number_id: cfg.phoneNumberId,
      customer_country_code: countryCode,
      customer_number: number,
      data: { type: 'text', context: { body: text, preview_url: false } },
      reply_to: null,
      myop_ref_id: null
    })
  });
    const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.status !== 'success') {
    throw new Error('HTTP ' + resp.status + ' — ' + JSON.stringify(data));
  }
  return data;
}

// Bulk send via MyOperator — mirrors the response/progress shape of the
// existing Baileys /api/wa/send route so the frontend needs no changes.
async function sendBulkViaMyOperator(db, io, user, body, file, res) {
  const { contacts, message } = body;
  if (!contacts || !message) return res.json({ ok: false, msg: 'contacts and message required' });
  if (message.length > 4000) return res.json({ ok: false, msg: 'Message too long' });

  let list;
  try { list = JSON.parse(contacts); } catch (e) { return res.json({ ok: false, msg: 'Invalid contacts' }); }
  if (!Array.isArray(list)) return res.json({ ok: false, msg: 'Invalid contacts' });

  res.json({ ok: true, total: list.length });

  const userId = user._id.toString();
  const cfg = user.myoperator;
  const business = user.business || user.name;
  let sent = 0;
  const logs = [];

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    let status = 'failed';
    try {
      const msg = String(message)
        .replace(/\{name\}/g, c.name || 'Customer')
        .replace(/\{store\}/g, business)
        .replace(/\{business\}/g, business);
      await sendTextMessage(cfg, c.phone, msg);
      status = 'sent';
      sent++;
      io.to('wa_' + userId).emit('sent', { index: i, phone: c.phone, name: c.name, status: 'sent', progress: { sent, total: list.length } });
      // Gentle pacing — protects the number's quality rating even on the official API.
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    } catch (err) {
            console.log('MyOperator send error:', err.message);
      io.to('wa_' + userId).emit('sent', { index: i, phone: c.phone, name: c.name, status: 'failed' });
    }
    logs.push({ userId, phone: c.phone, name: c.name, status, createdAt: new Date() });
  }

  if (logs.length) await db.collection('msg_logs').insertMany(logs);
  await db.collection('users').updateOne({ _id: user._id }, { $inc: { msgCount: sent } });
  io.to('wa_' + userId).emit('done', { total: list.length, sent });
}

function registerMyOperatorRoutes(app, db, clientAuth) {
  app.get('/api/wa/myoperator-status', clientAuth, async (req, res) => {
    const cfg = req.user.myoperator;
    res.json({
      ok: true,
      connected: !!(cfg && cfg.enabled),
      phoneNumberId: cfg ? cfg.phoneNumberId : null
    });
  });

  app.post('/api/wa/myoperator-connect', clientAuth, async (req, res) => {
    try {
      const apiKey = sanitize(req.body.apiKey, 300);
      const companyId = sanitize(req.body.companyId, 100);
      const phoneNumberId = sanitize(req.body.phoneNumberId, 100);
      if (!apiKey || !companyId || !phoneNumberId) {
        return res.json({ ok: false, msg: 'API key, Company ID and Phone Number ID are all required' });
      }
      await db.collection('users').updateOne(
        { _id: req.user._id },
        { $set: { myoperator: { enabled: true, apiKey, companyId, phoneNumberId, connectedAt: new Date() } } }
      );
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });

  app.post('/api/wa/myoperator-disconnect', clientAuth, async (req, res) => {
    await db.collection('users').updateOne({ _id: req.user._id }, { $unset: { myoperator: '' } });
    res.json({ ok: true });
  });
}

module.exports = { registerMyOperatorRoutes, sendBulkViaMyOperator, sendTextMessage };
