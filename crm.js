// ============================================================
// crm.js — WA Marketing SaaS
// Multi-location CRM: Locations + Leads/Calls tracking
// Native MongoDB driver (no mongoose) — mirrors google-review.js pattern
// ============================================================

const { ObjectId } = require('mongodb');

function sanitize(s, maxLen) {
  if (!s) return '';
  return String(s).trim().slice(0, maxLen || 200).replace(/[<>]/g, '');
}

const LEAD_SOURCES = ['google_ads', 'gmb', 'myoperator', 'walkin', 'referral', 'website', 'other'];
const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'];

function registerCrmRoutes(app, db, clientAuth, PLAN_FEATURES) {

  function crmAccess(req, res, next) {
    const features = PLAN_FEATURES[req.user.plan] || PLAN_FEATURES.starter;
    if (!features.jobs) {
      return res.json({ ok: false, msg: 'Leads & Locations CRM is available on Service plan and above.' });
    }
    next();
  }

  // ── LOCATIONS ──────────────────────────────────────────────────────────────
  app.get('/api/locations', clientAuth, crmAccess, async (req, res) => {
    try {
      const locations = await db.collection('locations')
        .find({ clientId: req.user._id.toString() }).sort({ createdAt: 1 }).toArray();
      res.json({ ok: true, locations });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.post('/api/locations', clientAuth, crmAccess, async (req, res) => {
    try {
      const name = sanitize(req.body.name, 100);
      const address = sanitize(req.body.address, 300);
      const phone = sanitize(req.body.phone, 15);
      if (!name) return res.json({ ok: false, msg: 'Location name required' });
      const clientId = req.user._id.toString();
      const count = await db.collection('locations').countDocuments({ clientId });
      if (count >= 50) return res.json({ ok: false, msg: 'Location limit reached (50 max)' });
      const doc = { clientId, name, address, phone, createdAt: new Date() };
      const r = await db.collection('locations').insertOne(doc);
      res.json({ ok: true, location: { ...doc, _id: r.insertedId } });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.put('/api/locations/:id', clientAuth, crmAccess, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.json({ ok: false, msg: 'Invalid ID' });
      const updates = {};
      if (req.body.name !== undefined) updates.name = sanitize(req.body.name, 100);
      if (req.body.address !== undefined) updates.address = sanitize(req.body.address, 300);
      if (req.body.phone !== undefined) updates.phone = sanitize(req.body.phone, 15);
      if (updates.name === '') return res.json({ ok: false, msg: 'Location name required' });
      await db.collection('locations').updateOne(
        { _id: new ObjectId(req.params.id), clientId: req.user._id.toString() },
        { $set: updates }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.delete('/api/locations/:id', clientAuth, crmAccess, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.json({ ok: false, msg: 'Invalid ID' });
      await db.collection('locations').deleteOne({ _id: new ObjectId(req.params.id), clientId: req.user._id.toString() });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // ── LEADS / CALLS ────────────────────────────────────────────────────────────
  app.get('/api/leads', clientAuth, crmAccess, async (req, res) => {
    try {
      const clientId = req.user._id.toString();
      const query = { clientId };
      const location = sanitize(req.query.location, 100);
      const source = sanitize(req.query.source, 30);
      const status = sanitize(req.query.status, 20);
      const search = sanitize(req.query.search, 100);
      if (location) query.location = location;
      if (source && LEAD_SOURCES.indexOf(source) !== -1) query.source = source;
      if (status && LEAD_STATUSES.indexOf(status) !== -1) query.status = status;
      if (search) {
        const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [{ name: { $regex: safe, $options: 'i' } }, { phone: { $regex: safe, $options: 'i' } }];
      }
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const total = await db.collection('leads').countDocuments(query);
      const leads = await db.collection('leads').find(query).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).toArray();
      res.json({ ok: true, leads, total });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.get('/api/leads/stats', clientAuth, crmAccess, async (req, res) => {
    try {
      const clientId = req.user._id.toString();
      const all = await db.collection('leads').find({ clientId }).toArray();
      const total = all.length;
      const byStatus = {}, byLocation = {}, bySource = {};
      all.forEach(l => {
        byStatus[l.status] = (byStatus[l.status] || 0) + 1;
        const loc = l.location || 'Unspecified';
        if (!byLocation[loc]) byLocation[loc] = { total: 0, converted: 0 };
        byLocation[loc].total++;
        if (l.status === 'converted') byLocation[loc].converted++;
        bySource[l.source || 'other'] = (bySource[l.source || 'other'] || 0) + 1;
      });
      const converted = byStatus.converted || 0;
      res.json({
        ok: true, total, converted,
        convRate: total ? Math.round((converted / total) * 100) : 0,
        byStatus, byLocation, bySource
      });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.post('/api/leads', clientAuth, crmAccess, async (req, res) => {
    try {
      const name = sanitize(req.body.name, 100);
      const phone = sanitize(req.body.phone, 15);
      const location = sanitize(req.body.location, 100);
      const source = LEAD_SOURCES.indexOf(req.body.source) !== -1 ? req.body.source : 'other';
      const notes = sanitize(req.body.notes, 1000);
      if (!name || !phone) return res.json({ ok: false, msg: 'Name and phone required' });
      const doc = {
        clientId: req.user._id.toString(), name, phone, location, source,
        status: 'new', notes, jobId: null,
        createdAt: new Date(), updatedAt: new Date()
      };
      const r = await db.collection('leads').insertOne(doc);
      res.json({ ok: true, lead: { ...doc, _id: r.insertedId } });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // Bulk import — e.g. MyOperator / Google Sheets call-log CSV export
  app.post('/api/leads/import', clientAuth, crmAccess, async (req, res) => {
    try {
      const rows = req.body.rows;
      if (!Array.isArray(rows) || !rows.length) return res.json({ ok: false, msg: 'No rows to import' });
      if (rows.length > 2000) return res.json({ ok: false, msg: 'Max 2000 rows per import' });
      const clientId = req.user._id.toString();
      const docs = [];
      for (const row of rows) {
        const name = sanitize(row.name, 100);
        const phone = sanitize(row.phone, 15);
        if (!name || !phone) continue;
        const location = sanitize(row.location, 100);
        const source = LEAD_SOURCES.indexOf(row.source) !== -1 ? row.source : 'myoperator';
        const notes = sanitize(row.notes, 1000);
        let createdAt = new Date();
        if (row.createdAt) { const d = new Date(row.createdAt); if (!isNaN(d.getTime())) createdAt = d; }
        docs.push({ clientId, name, phone, location, source, status: 'new', notes, jobId: null, createdAt, updatedAt: new Date() });
      }
      if (!docs.length) return res.json({ ok: false, msg: 'No valid rows found (Name + Phone required in every row)' });
      await db.collection('leads').insertMany(docs);
      res.json({ ok: true, imported: docs.length });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.put('/api/leads/:id', clientAuth, crmAccess, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.json({ ok: false, msg: 'Invalid ID' });
      const updates = { updatedAt: new Date() };
      if (req.body.status !== undefined && LEAD_STATUSES.indexOf(req.body.status) !== -1) updates.status = req.body.status;
      if (req.body.notes !== undefined) updates.notes = sanitize(req.body.notes, 1000);
      if (req.body.location !== undefined) updates.location = sanitize(req.body.location, 100);
      if (req.body.source !== undefined && LEAD_SOURCES.indexOf(req.body.source) !== -1) updates.source = req.body.source;
      if (req.body.name !== undefined) updates.name = sanitize(req.body.name, 100);
      if (req.body.phone !== undefined) updates.phone = sanitize(req.body.phone, 15);
      await db.collection('leads').updateOne(
        { _id: new ObjectId(req.params.id), clientId: req.user._id.toString() },
        { $set: updates }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.delete('/api/leads/:id', clientAuth, crmAccess, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.json({ ok: false, msg: 'Invalid ID' });
      await db.collection('leads').deleteOne({ _id: new ObjectId(req.params.id), clientId: req.user._id.toString() });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  // Link a lead to a job created from it (marks converted)
  app.put('/api/leads/:id/link-job', clientAuth, crmAccess, async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.json({ ok: false, msg: 'Invalid ID' });
      const jobId = sanitize(req.body.jobId, 30);
      if (!jobId) return res.json({ ok: false, msg: 'jobId required' });
      await db.collection('leads').updateOne(
        { _id: new ObjectId(req.params.id), clientId: req.user._id.toString() },
        { $set: { status: 'converted', jobId, updatedAt: new Date() } }
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, msg: e.message }); }
  });
}

module.exports = { registerCrmRoutes, LEAD_SOURCES, LEAD_STATUSES };
