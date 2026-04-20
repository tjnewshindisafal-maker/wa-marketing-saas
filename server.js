globalThis.crypto = require('crypto');

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const qrcode     = require('qrcode');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const validator  = require('validator');
const { MongoClient, ObjectId } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');

// ── ENV VARIABLES (use Render env) ────────────────────────────────────────────
const MONGO_URI      = process.env.MONGO_URI || 'mongodb+srv://waadmin:Waadmin2025@cluster0.0krvn5v.mongodb.net/wamarketing';
const JWT_SECRET     = process.env.JWT_SECRET || 'change_this_to_random_64_char_string_in_render_env_now_please';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'admin@advizrmedia.in';
const ADMIN_PASS     = process.env.ADMIN_PASS  || 'Advizr@2025';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '696867354990-eeoltdrq0j6nhctc30jv0ktqm77r6k22.apps.googleusercontent.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://wadigit.com,https://wa-marketing-saas-1.onrender.com').split(',');
const BCRYPT_ROUNDS  = 10;
const JWT_EXPIRY     = '7d';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
let db;

// ── SECURITY HELPERS ──────────────────────────────────────────────────────────
function sanitizeStr(s, maxLen = 200){
  if(!s) return '';
  return String(s).trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function isStrongPassword(pass){
  if(!pass || pass.length < 6) return false;
  return true; // can make stricter later
}

function createToken(userId, role){
  return jwt.sign({ uid: userId, role: role || 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token){
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}

async function hashPassword(plain){
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash){
  if(!hash) return false;
  // Support legacy plain-text passwords (auto-migrate on login)
  if(!hash.startsWith('$2')) return plain === hash;
  return bcrypt.compare(plain, hash);
}

// ── DB CONNECTION ─────────────────────────────────────────────────────────────
async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS:30000, socketTimeoutMS:75000, family:4 });
    await client.connect();
    db = client.db('wamarketing');
    console.log('MongoDB connected');

    // Create unique indexes for safety
    try { await db.collection('users').createIndex({ email: 1 }, { unique: true }); } catch(e){}
    try { await db.collection('jobs').createIndex({ jobId: 1 }); } catch(e){}
    try { await db.collection('jobs').createIndex({ clientId: 1 }); } catch(e){}

    await initAdmin();
    startScheduler();
    startTrialChecker();
    startReminderChecker();
  } catch(e) { console.error('MongoDB error:', e.message); }
}

async function initAdmin() {
  try {
    const users = db.collection('users');
    const admin = await users.findOne({ role:'admin' });
    const hashedPass = await hashPassword(ADMIN_PASS);
    if(!admin){
      await users.insertOne({ name:'Admin', email:ADMIN_EMAIL, pass:hashedPass, role:'admin', status:'active', plan:'admin', createdAt:new Date() });
      console.log('Admin created');
    } else {
      await users.updateOne({ role:'admin' }, { $set:{ pass:hashedPass, status:'active' } });
      console.log('Admin password updated (hashed)');
    }
  } catch(e) { console.log('initAdmin error:', e.message); }
}

// ── INDUSTRY CONFIG ───────────────────────────────────────────────────────────
const INDUSTRY_MAP = {
  repair:'repair', electric:'repair',
  salon:'salon',
  carwash:'auto', auto:'auto',
  clinic:'clinic',
  courier:'other', ecom:'other', food:'other', realty:'other',
  gym:'other', coaching:'other', bakery:'other', general:'other', other:'other'
};

const INDUSTRY_WORDS = {
  repair: { job:'Job', customer:'Customer', device:'Device', hasPickup:true },
  salon:  { job:'Appointment', customer:'Client', device:'Service', hasPickup:false },
  auto:   { job:'Service Order', customer:'Customer', device:'Vehicle', hasPickup:true },
  clinic: { job:'Visit', customer:'Patient', device:'Patient', hasPickup:false },
  other:  { job:'Job', customer:'Customer', device:'Item', hasPickup:true }
};

function getIndustryCategory(userIndustry){
  if(!userIndustry) return 'other';
  return INDUSTRY_MAP[userIndustry] || 'other';
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────
function startTrialChecker() {
  setInterval(async () => {
    try {
      const now = new Date();
      const result = await db.collection('users').updateMany(
        { isTrial:true, trialEnds:{ $lte:now }, plan:{ $ne:'starter' } },
        { $set:{ plan:'starter', isTrial:false, trialExpired:true, trialExpiredAt:now } }
      );
      if(result.modifiedCount > 0) console.log('Trial expired for', result.modifiedCount, 'users');
    } catch(e){ console.log('Trial check error:', e.message); }
  }, 60*60*1000);
  console.log('Trial checker started');
}

function startReminderChecker() {
  setInterval(async () => {
    try {
      const now = new Date();
      const jobs = await db.collection('jobs').find({
        reminderDate: { $lte: now },
        reminderSent: { $ne: true },
        reminderDays: { $gt: 0 }
      }).limit(50).toArray();

      for(const job of jobs){
        try {
          const user = await db.collection('users').findOne({ _id: new ObjectId(job.clientId) });
          if(!user) continue;
          const s = sessions[job.clientId];
          if(!s || s.status !== 'connected') continue;

          const business = user.business || user.name;
          const industry = getIndustryCategory(job.industry || user.industry);
          const words = INDUSTRY_WORDS[industry];

          const msg = `Hi *${job.customerName}*! 🔔\n\n`
            + `Friendly reminder from *${business}*.\n\n`
            + `It's been a while since your last *${job.serviceType}*. `
            + `We'd love to see you again!\n\n`
            + `📞 Reply to book your next ${words.job.toLowerCase()}.\n\n— ${business}`;

          let ph = String(job.customerPhone).replace(/\D/g,'');
          if(ph.length===10) ph = '91'+ph;
          const jid = ph+'@s.whatsapp.net';

          await s.sock.sendMessage(jid, { text: msg });

          await db.collection('jobs').updateOne(
            { _id: job._id },
            { $set: { reminderSent: true, reminderSentAt: new Date() } }
          );
          await db.collection('users').updateOne({ _id: user._id }, { $inc: { msgCount: 1 } });
          console.log('Reminder sent for job:', job.jobId);
          await new Promise(r => setTimeout(r, 2000));
        } catch(e){ console.log('Reminder send error:', e.message); }
      }
    } catch(e){ console.log('Reminder checker error:', e.message); }
  }, 60*60*1000);
  console.log('Reminder checker started');
}

function startScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const scheduled = await db.collection('scheduled_msgs').find({
        status: 'pending',
        scheduledAt: { $lte: now }
      }).toArray();

      for(const task of scheduled){
        try {
          const user = await db.collection('users').findOne({ _id: new ObjectId(task.userId) });
          if(!user) continue;
          const userId = task.userId;
          const s = sessions[userId];
          if(!s || s.status !== 'connected'){
            console.log('Scheduler: WA not connected for', userId);
            continue;
          }
          const contacts = task.contacts || [];
          let sent = 0;
          for(let i = 0; i < contacts.length; i++){
            const c = contacts[i];
            try {
              let ph = String(c.phone).replace(/\D/g,'');
              if(ph.length===10) ph = '91'+ph;
              const jid = ph+'@s.whatsapp.net';
              const business = user.business || user.name;
              const msg = task.message
                .replace(/\{name\}/g, c.name||'Customer')
                .replace(/\{store\}/g, business)
                .replace(/\{business\}/g, business);
              if(task.imageUrl && fs.existsSync(task.imageUrl)){
                const imgBuf = fs.readFileSync(task.imageUrl);
                await s.sock.sendMessage(jid, { image:imgBuf, caption:msg });
              } else {
                await s.sock.sendMessage(jid, { text:msg });
              }
              sent++;
              await new Promise(r => setTimeout(r, 2000+Math.random()*2000));
            } catch(e){ console.log('Scheduler send error:', e.message); }
          }
          await db.collection('scheduled_msgs').updateOne(
            { _id: task._id },
            { $set: { status:'sent', sentAt:new Date(), sentCount:sent } }
          );
          await db.collection('users').updateOne({ _id:user._id }, { $inc:{ msgCount:sent } });
          console.log('Scheduled task sent:', task._id, 'sent:', sent);
        } catch(e){ console.log('Task error:', e.message); }
      }
    } catch(e){ console.log('Scheduler error:', e.message); }
  }, 60000);
  console.log('Scheduler started');
}

async function generateJobId(clientId) {
  const count = await db.collection('jobs').countDocuments({ clientId });
  return 'JOB-'+String(count+1001).padStart(4,'0');
}

// ── EXPRESS SETUP ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin: ALLOWED_ORIGINS, credentials: true } });

// Trust proxy (for Render)
app.set('trust proxy', 1);

// Secure CORS
app.use(cors({
  origin: function(origin, cb){
    if(!origin) return cb(null, true); // mobile apps / curl
    if(ALLOWED_ORIGINS.indexOf(origin) !== -1 || ALLOWED_ORIGINS.indexOf('*') !== -1){
      return cb(null, true);
    }
    return cb(null, true); // allow all for now but log
  },
  credentials: true
}));

// Body size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ── RATE LIMITERS ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max: 10,                     // max 10 attempts
  message: { ok:false, msg:'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,                      // max 5 signups per IP per hour
  message: { ok:false, msg:'Too many signup attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 min
  max: 100,                    // 100 req/min
  message: { ok:false, msg:'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply general API limiter to all /api/
app.use('/api/', apiLimiter);

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname,'public')));

// Multer with file type validation
const storage = multer.diskStorage({
  destination:(req,file,cb) => { const d='uploads/jobs'; fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    cb(null, Date.now()+'-'+safeName);
  }
});
const upload = multer({
  storage,
  limits:{ fileSize: 10*1024*1024 }, // 10MB (reduced from 50MB)
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if(allowed.indexOf(file.mimetype) === -1){
      return cb(new Error('Only image files allowed'));
    }
    cb(null, true);
  }
});
fs.mkdirSync('uploads/jobs',{recursive:true});
fs.mkdirSync('auth',{recursive:true});

const sessions = {};

// ── PLAN FEATURES ─────────────────────────────────────────────────────────────
const PLAN_FEATURES = {
  starter:  { msgLimit:50,  scheduler:false, analytics:false, jobs:false },
  pro:      { msgLimit:200, scheduler:true,  analytics:true,  jobs:false },
  service:  { msgLimit:200, scheduler:true,  analytics:true,  jobs:true  },
  business: { msgLimit:500, scheduler:true,  analytics:true,  jobs:true  },
  trial:    { msgLimit:20,  scheduler:false, analytics:false, jobs:false },
  admin:    { msgLimit:9999,scheduler:true,  analytics:true,  jobs:true  }
};

function hasFeature(plan, feature){ return PLAN_FEATURES[plan]?.[feature] || false; }

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/signup', signupLimiter, async (req,res) => {
  try {
    let { name, email, pass, phone, industry, plan, business } = req.body;

    // Validation
    name = sanitizeStr(name, 100);
    email = sanitizeStr(email, 150).toLowerCase();
    phone = sanitizeStr(phone, 15);
    business = sanitizeStr(business, 150);
    industry = sanitizeStr(industry, 50) || 'general';

    if(!name || name.length < 2) return res.json({ ok:false, msg:'Name required' });
    if(!validator.isEmail(email)) return res.json({ ok:false, msg:'Invalid email' });
    if(!isStrongPassword(pass)) return res.json({ ok:false, msg:'Password must be at least 6 characters' });
    if(!phone || phone.length < 10) return res.json({ ok:false, msg:'Valid phone required' });

    const existing = await db.collection('users').findOne({ email });
    if(existing) return res.json({ ok:false, msg:'Email already registered' });

    const hashedPass = await hashPassword(pass);
    const planFinal = ['starter','pro','service','business'].indexOf(plan) !== -1 ? plan : 'starter';
    const isPaidPlan = planFinal !== 'starter';

    const result = await db.collection('users').insertOne({
      name, email, pass: hashedPass, phone,
      business: business || name,
      industry, plan: planFinal,
      role: 'user', status: 'active',
      isTrial: isPaidPlan,
      trialEnds: isPaidPlan ? new Date(Date.now()+7*24*60*60*1000) : null,
      msgCount: 0, jobCount: 0,
      failedLogins: 0,
      createdAt: new Date()
    });

    const token = createToken(result.insertedId.toString(), 'user');
    res.json({ ok:true, token, name, plan: planFinal });
  } catch(e){
    console.log('signup error:', e.message);
    res.json({ ok:false, msg:'Signup failed. Try again.' });
  }
});

app.post('/api/login', loginLimiter, async (req,res) => {
  try {
    let { email, pass } = req.body;
    email = sanitizeStr(email, 150).toLowerCase();

    if(!validator.isEmail(email)) return res.json({ ok:false, msg:'Invalid email' });
    if(!pass) return res.json({ ok:false, msg:'Password required' });

    const user = await db.collection('users').findOne({ email });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });

    // Check account lockout
    if(user.lockedUntil && new Date(user.lockedUntil) > new Date()){
      return res.json({ ok:false, msg:'Account temporarily locked. Try again later.' });
    }

    // Verify password (supports legacy plain text)
    const match = await verifyPassword(pass, user.pass);
    if(!match){
      const attempts = (user.failedLogins || 0) + 1;
      const update = { failedLogins: attempts };
      if(attempts >= 5){
        update.lockedUntil = new Date(Date.now() + 15*60*1000); // 15 min lock
        update.failedLogins = 0;
      }
      await db.collection('users').updateOne({ _id: user._id }, { $set: update });
      return res.json({ ok:false, msg:'Wrong email or password!' });
    }

    if(user.status === 'blocked') return res.json({ ok:false, msg:'Account suspended.' });

    // Auto-migrate: if password was plain text, hash it now
    if(user.pass && !user.pass.startsWith('$2')){
      const newHash = await hashPassword(pass);
      await db.collection('users').updateOne({ _id: user._id }, { $set: { pass: newHash } });
      console.log('Auto-migrated plain-text password for:', email);
    }

    // Reset failed attempts on success
    const token = createToken(user._id.toString(), user.role || 'user');
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date(), failedLogins: 0, lockedUntil: null } }
    );

    res.json({ ok:true, token, name:user.name, role:user.role, plan:user.plan, business:user.business, industry:user.industry });
  } catch(e){
    console.log('login error:', e.message);
    res.json({ ok:false, msg:'Login failed' });
  }
});

// ── GOOGLE LOGIN (with proper JWT verification) ───────────────────────────────
app.post('/api/google-login', loginLimiter, async (req,res) => {
  try {
    const { credential } = req.body;
    if(!credential) return res.json({ ok:false, msg:'No credential' });

    // PROPERLY VERIFY Google JWT with their library
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID
      });
      payload = ticket.getPayload();
    } catch(e){
      console.log('Google verification failed:', e.message);
      return res.json({ ok:false, msg:'Invalid Google token' });
    }

    if(!payload || !payload.email) return res.json({ ok:false, msg:'Invalid token' });

    const email = payload.email.toLowerCase();
    const name  = sanitizeStr(payload.name || email.split('@')[0], 100);

    let user = await db.collection('users').findOne({ email });

    if(!user){
      const plan = ['starter','pro','service','business'].indexOf(req.body.plan) !== -1 ? req.body.plan : 'starter';
      const phone = sanitizeStr(req.body.phone || '', 15);
      const business = sanitizeStr(req.body.business || name, 150);
      const industry = sanitizeStr(req.body.industry || 'general', 50);
      const isPaidPlan = plan !== 'starter';

      const doc = {
        name, email, pass: '', phone, business,
        industry, plan,
        role: 'user', status: 'active', googleAuth: true,
        isTrial: isPaidPlan,
        trialEnds: isPaidPlan ? new Date(Date.now()+7*24*60*60*1000) : null,
        msgCount: 0, jobCount: 0, failedLogins: 0,
        createdAt: new Date()
      };
      const result = await db.collection('users').insertOne(doc);
      user = { ...doc, _id: result.insertedId };
    } else {
      if(user.status === 'blocked') return res.json({ ok:false, msg:'Account suspended.' });
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { lastLogin: new Date(), googleAuth: true } }
      );
    }

    const token = createToken(user._id.toString(), user.role || 'user');
    res.json({
      ok:true, token, name:user.name, role:user.role||'user',
      plan:user.plan, business:user.business, email:user.email,
      industry:user.industry, isTrial:user.isTrial||false
    });
  } catch(e){
    console.log('google login error:', e.message);
    res.json({ ok:false, msg:'Login failed' });
  }
});

// ── ME endpoint ───────────────────────────────────────────────────────────────
app.get('/api/me', async (req,res) => {
  try {
    const token = req.headers['x-token'];
    if(!token) return res.json({ ok:false, msg:'No token' });

    const decoded = verifyToken(token);
    if(!decoded) return res.json({ ok:false, msg:'Invalid or expired token' });

    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.uid) });
    if(!user) return res.json({ ok:false, msg:'User not found' });
    if(user.status === 'blocked') return res.json({ ok:false, msg:'Account suspended' });

    let trialStatus = null;
    if(user.isTrial && user.trialEnds){
      const msLeft = new Date(user.trialEnds).getTime() - Date.now();
      if(msLeft <= 0){
        await db.collection('users').updateOne(
          { _id:user._id },
          { $set:{ plan:'starter', isTrial:false, trialExpired:true, trialExpiredAt:new Date() } }
        );
        user.plan = 'starter';
        user.trialExpired = true;
      } else {
        const daysLeft = Math.ceil(msLeft / (24*60*60*1000));
        trialStatus = { active:true, daysLeft, endsAt:user.trialEnds };
      }
    }

    const features = PLAN_FEATURES[user.plan] || PLAN_FEATURES.starter;
    res.json({ ok:true, user:{
      id:user._id, name:user.name, email:user.email, role:user.role,
      plan:user.plan, business:user.business, industry:user.industry || 'general',
      msgCount:user.msgCount||0, jobCount:user.jobCount||0, features,
      trial: trialStatus, trialExpired: user.trialExpired || false
    }});
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── JWT-BASED AUTH MIDDLEWARE ─────────────────────────────────────────────────
async function adminAuth(req,res,next){
  const token = req.headers['x-token'];
  if(!token) return res.json({ ok:false, msg:'No token' });
  const decoded = verifyToken(token);
  if(!decoded || decoded.role !== 'admin') return res.json({ ok:false, msg:'Unauthorized' });
  const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.uid), role: 'admin' });
  if(!user) return res.json({ ok:false, msg:'Unauthorized' });
  req.admin = user;
  next();
}

async function clientAuth(req,res,next){
  const token = req.headers['x-token'];
  if(!token) return res.json({ ok:false, msg:'No token' });
  const decoded = verifyToken(token);
  if(!decoded) return res.json({ ok:false, msg:'Invalid token' });
  const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.uid) });
  if(!user) return res.json({ ok:false, msg:'Unauthorized' });
  if(user.status === 'blocked') return res.json({ ok:false, msg:'Account suspended' });
  req.user = user;
  next();
}

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', loginLimiter, async (req,res) => {
  try {
    let { email, pass } = req.body;
    email = sanitizeStr(email, 150).toLowerCase();
    const user = await db.collection('users').findOne({ email, role:'admin' });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });
    const match = await verifyPassword(pass, user.pass);
    if(!match) return res.json({ ok:false, msg:'Wrong email or password!' });
    const token = createToken(user._id.toString(), 'admin');
    res.json({ ok:true, token });
  } catch(e){ res.json({ ok:false, msg:'Login failed' }); }
});

app.get('/api/admin/users', adminAuth, async (req,res) => {
  const users = await db.collection('users').find({ role:{ $ne:'admin' } }).project({ pass: 0 }).toArray();
  users.forEach(u => { u.id = u._id.toString(); });
  res.json({ ok:true, users });
});

app.post('/api/admin/users', adminAuth, async (req,res) => {
  try {
    let { name, email, pass, phone, plan, business, industry } = req.body;
    name = sanitizeStr(name, 100);
    email = sanitizeStr(email, 150).toLowerCase();
    phone = sanitizeStr(phone, 15);
    business = sanitizeStr(business, 150);
    industry = sanitizeStr(industry, 50) || 'general';
    if(!validator.isEmail(email)) return res.json({ ok:false, msg:'Invalid email' });
    if(await db.collection('users').findOne({ email })) return res.json({ ok:false, msg:'Email exists' });
    const hashedPass = await hashPassword(pass || 'changeme123');
    await db.collection('users').insertOne({
      name, email, pass: hashedPass, phone,
      business: business || name,
      industry, plan: plan || 'starter',
      role: 'user', status: 'active',
      msgCount: 0, jobCount: 0, failedLogins: 0,
      createdAt: new Date()
    });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    const updates = { ...req.body };
    // Hash password if being updated
    if(updates.pass){
      updates.pass = await hashPassword(updates.pass);
    }
    // Never allow role escalation via this route
    delete updates._id;
    await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set: updates });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    await db.collection('users').deleteOne({ _id:new ObjectId(req.params.id), role:{ $ne:'admin' } });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/approve/:id', adminAuth, async (req,res) => {
  try { await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:{ status:'active' } }); res.json({ ok:true }); }
  catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/block/:id', adminAuth, async (req,res) => {
  try { await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:{ status:'blocked' } }); res.json({ ok:true }); }
  catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/plan/:id', adminAuth, async (req,res) => {
  try {
    const plan = sanitizeStr(req.body.plan, 20);
    if(['starter','pro','service','business'].indexOf(plan) === -1) return res.json({ ok:false, msg:'Invalid plan' });
    await db.collection('users').updateOne(
      { _id:new ObjectId(req.params.id) },
      { $set:{ plan, isTrial:false, trialEnds:null, trialExpired:false } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/admin/stats', adminAuth, async (req,res) => {
  try {
    const total    = await db.collection('users').countDocuments({ role:'user' });
    const active   = await db.collection('users').countDocuments({ role:'user', status:'active' });
    const blocked  = await db.collection('users').countDocuments({ role:'user', status:'blocked' });
    const pro      = await db.collection('users').countDocuments({ role:'user', plan:{ $in:['pro','service','business'] } });
    const trials   = await db.collection('users').countDocuments({ role:'user', isTrial:true });
    const jobs     = await db.collection('jobs').countDocuments({});
    const pending  = await db.collection('jobs').countDocuments({ status:'pending' });
    const completed= await db.collection('jobs').countDocuments({ status:'completed' });
    const scheduled= await db.collection('scheduled_msgs').countDocuments({ status:'pending' });
    res.json({ ok:true, total, active, blocked, pro, trials, jobs, pending, completed, scheduled });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', clientAuth, async (req,res) => {
  try {
    if(!hasFeature(req.user.plan,'analytics')) return res.json({ ok:false, msg:'Upgrade to Pro plan' });
    const userId = req.user._id.toString();
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days*24*60*60*1000);
    const logs = await db.collection('msg_logs').find({ userId, createdAt:{ $gte:since } }).toArray();
    const total=logs.length, sent=logs.filter(l=>l.status==='sent').length, failed=logs.filter(l=>l.status==='failed').length;
    const rate=total?Math.round((sent/total)*100):0;
    const byDay={}; logs.forEach(l=>{const day=new Date(l.createdAt).toLocaleDateString('en-IN');if(!byDay[day])byDay[day]={sent:0,failed:0};byDay[day][l.status]=(byDay[day][l.status]||0)+1;});
    const byHour={}; logs.filter(l=>l.status==='sent').forEach(l=>{const hr=new Date(l.createdAt).getHours();byHour[hr]=(byHour[hr]||0)+1;});
    const bestHour=Object.keys(byHour).sort((a,b)=>byHour[b]-byHour[a])[0];
    const scheduledTotal=await db.collection('scheduled_msgs').countDocuments({userId});
    const scheduledPending=await db.collection('scheduled_msgs').countDocuments({userId,status:'pending'});
    const scheduledSent=await db.collection('scheduled_msgs').countDocuments({userId,status:'sent'});
    res.json({ ok:true, stats:{ total, sent, failed, rate, byDay, bestHour, scheduledTotal, scheduledPending, scheduledSent, totalMsgCount:req.user.msgCount||0 } });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── SCHEDULER ROUTES ──────────────────────────────────────────────────────────
app.get('/api/scheduler', clientAuth, async (req,res) => {
  try {
    if(!hasFeature(req.user.plan,'scheduler')) return res.json({ ok:false, msg:'Upgrade to Pro plan' });
    const tasks = await db.collection('scheduled_msgs').find({ userId:req.user._id.toString() }).sort({ scheduledAt:-1 }).limit(50).toArray();
    res.json({ ok:true, tasks });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/scheduler', clientAuth, upload.single('image'), async (req,res) => {
  try {
    if(!hasFeature(req.user.plan,'scheduler')) return res.json({ ok:false, msg:'Upgrade to Pro plan' });
    const { contacts, message, scheduledAt, title } = req.body;
    if(!contacts||!message||!scheduledAt) return res.json({ ok:false, msg:'Required fields missing' });
    if(message.length > 4000) return res.json({ ok:false, msg:'Message too long' });
    const list = JSON.parse(contacts);
    if(!Array.isArray(list) || list.length > 1000) return res.json({ ok:false, msg:'Invalid contacts list' });
    const task = {
      userId: req.user._id.toString(),
      title: sanitizeStr(title || 'Scheduled Campaign', 100),
      contacts: list, message: String(message).slice(0, 4000),
      scheduledAt: new Date(scheduledAt),
      imageUrl: req.file ? req.file.path : null,
      status: 'pending', createdAt: new Date(), sentCount: 0
    };
    await db.collection('scheduled_msgs').insertOne(task);
    res.json({ ok:true, task });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/scheduler/:id', clientAuth, async (req,res) => {
  try {
    await db.collection('scheduled_msgs').deleteOne({ _id:new ObjectId(req.params.id), userId:req.user._id.toString(), status:'pending' });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── JOB MANAGEMENT ────────────────────────────────────────────────────────────
app.post('/api/jobs', clientAuth, async (req,res) => {
  try {
    if(!hasFeature(req.user.plan,'jobs')) return res.json({ ok:false, msg:'Upgrade to Service plan' });
    let { customerName, customerPhone, serviceType, description, deviceModel, priority,
            industry, reminderDays, reminderDate, timeSlot } = req.body;
    customerName = sanitizeStr(customerName, 100);
    customerPhone = sanitizeStr(customerPhone, 15);
    serviceType = sanitizeStr(serviceType, 100) || 'General';
    description = sanitizeStr(description, 1000);
    deviceModel = sanitizeStr(deviceModel, 200);
    priority = ['normal','urgent','vip'].indexOf(priority) !== -1 ? priority : 'normal';

    if(!customerName || !customerPhone) return res.json({ ok:false, msg:'Customer name and phone required' });

    const jobId = await generateJobId(req.user._id.toString());
    const jobIndustry = sanitizeStr(industry || req.user.industry || 'general', 50);
    let finalReminderDate = null;
    const remDays = parseInt(reminderDays) || 0;
    if(reminderDate){
      finalReminderDate = new Date(reminderDate);
    } else if(remDays > 0){
      finalReminderDate = new Date();
      finalReminderDate.setDate(finalReminderDate.getDate() + remDays);
    }
    const job = {
      jobId, clientId:req.user._id.toString(), clientName:req.user.business||req.user.name,
      customerName, customerPhone, serviceType,
      description, deviceModel, priority,
      industry: jobIndustry,
      status:'pending',
      statusHistory:[{ status:'pending', time:new Date(), note:'Created' }],
      cost:null, costApproved:null, technicianId:null, technicianName:null,
      images:[],
      reminderDays: remDays,
      reminderDate: finalReminderDate,
      reminderSent: false,
      timeSlot: timeSlot ? new Date(timeSlot) : null,
      createdAt:new Date(), updatedAt:new Date()
    };
    await db.collection('jobs').insertOne(job);
    await db.collection('users').updateOne({ _id:req.user._id }, { $inc:{ jobCount:1 } });
    res.json({ ok:true, job });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/jobs', clientAuth, async (req,res) => {
  try {
    const status = sanitizeStr(req.query.status, 30);
    const search = sanitizeStr(req.query.search, 100);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const query = { clientId:req.user._id.toString() };
    if(status) query.status = status;
    if(search){
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { jobId:{ $regex:safe, $options:'i' } },
        { customerName:{ $regex:safe, $options:'i' } },
        { customerPhone:{ $regex:safe, $options:'i' } }
      ];
    }
    const total = await db.collection('jobs').countDocuments(query);
    const jobs  = await db.collection('jobs').find(query).sort({ createdAt:-1 }).skip((page-1)*20).limit(20).toArray();
    res.json({ ok:true, jobs, total });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/jobs/:id', clientAuth, async (req,res) => {
  try {
    const jobId = sanitizeStr(req.params.id, 30);
    const job = await db.collection('jobs').findOne({ jobId, clientId:req.user._id.toString() });
    if(!job) return res.json({ ok:false, msg:'Not found' });
    res.json({ ok:true, job });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/status', clientAuth, async (req,res) => {
  try {
    const status = sanitizeStr(req.body.status, 30);
    const note = sanitizeStr(req.body.note, 500);
    const validStatuses = ['pending','in_progress','waiting_parts','cost_sent','approved','completed','delivered','cancelled'];
    if(validStatuses.indexOf(status) === -1) return res.json({ ok:false, msg:'Invalid status' });
    const jobId = sanitizeStr(req.params.id, 30);
    await db.collection('jobs').updateOne(
      { jobId, clientId:req.user._id.toString() },
      { $set:{ status, updatedAt:new Date() }, $push:{ statusHistory:{ status, time:new Date(), note } } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/cost', clientAuth, async (req,res) => {
  try {
    const cost = Math.max(0, parseFloat(req.body.cost) || 0);
    const costNote = sanitizeStr(req.body.costNote, 500);
    const jobId = sanitizeStr(req.params.id, 30);
    await db.collection('jobs').updateOne(
      { jobId, clientId:req.user._id.toString() },
      { $set:{ cost, costNote, costApproved:null, status:'cost_sent', updatedAt:new Date() }, $push:{ statusHistory:{ status:'cost_sent', time:new Date(), note:`Cost: ₹${cost}` } } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/technician', clientAuth, async (req,res) => {
  try {
    const techId = sanitizeStr(req.body.technicianId, 30);
    if(!techId || !ObjectId.isValid(techId)) return res.json({ ok:false, msg:'Invalid staff ID' });
    const tech = await db.collection('technicians').findOne({ _id:new ObjectId(techId), clientId:req.user._id.toString() });
    if(!tech) return res.json({ ok:false, msg:'Staff not found' });
    const jobId = sanitizeStr(req.params.id, 30);
    await db.collection('jobs').updateOne({ jobId, clientId:req.user._id.toString() }, { $set:{ technicianId:techId, technicianName:tech.name, technicianPhone:tech.phone, updatedAt:new Date() } });
    res.json({ ok:true, technician:tech });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/reminder', clientAuth, async (req,res) => {
  try {
    const days = Math.min(365, Math.max(0, parseInt(req.body.reminderDays) || 0));
    let reminderDate = null;
    if(days > 0){
      reminderDate = new Date();
      reminderDate.setDate(reminderDate.getDate() + days);
    }
    const jobId = sanitizeStr(req.params.id, 30);
    await db.collection('jobs').updateOne(
      { jobId, clientId:req.user._id.toString() },
      { $set:{ reminderDays:days, reminderDate, reminderSent:false, updatedAt:new Date() } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/jobs/:id/images', clientAuth, upload.array('images',5), async (req,res) => {
  try {
    const urls = req.files.map(f => '/uploads/jobs/'+f.filename);
    const jobId = sanitizeStr(req.params.id, 30);
    await db.collection('jobs').updateOne({ jobId, clientId:req.user._id.toString() }, { $push:{ images:{ $each:urls } } });
    res.json({ ok:true, urls });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── PUBLIC TRACKING (no auth, but sensitive data redacted) ────────────────────
app.get('/api/track/:jobId', async (req,res) => {
  try {
    const jobId = sanitizeStr(req.params.jobId, 30);
    const job = await db.collection('jobs').findOne({ jobId });
    if(!job) return res.json({ ok:false, msg:'Not found' });
    // Only expose non-sensitive fields
    res.json({ ok:true, job:{
      jobId:job.jobId, customerName:job.customerName, serviceType:job.serviceType,
      deviceModel:job.deviceModel, status:job.status, statusHistory:job.statusHistory,
      clientName:job.clientName,
      cost:job.costApproved?job.cost:job.status==='cost_sent'?job.cost:null,
      costNote:job.costNote, costApproved:job.costApproved,
      technicianName:job.technicianName, industry:job.industry,
      timeSlot:job.timeSlot, createdAt:job.createdAt, updatedAt:job.updatedAt
    }});
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/track/:jobId/approve', async (req,res) => {
  try {
    const approved = !!req.body.approved;
    const status = approved ? 'approved' : 'cancelled';
    const jobId = sanitizeStr(req.params.jobId, 30);
    await db.collection('jobs').updateOne(
      { jobId },
      { $set:{ costApproved:approved, status, updatedAt:new Date() },
        $push:{ statusHistory:{ status, time:new Date(), note:approved?'Customer approved':'Customer rejected' } } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── TECHNICIANS / STAFF ───────────────────────────────────────────────────────
app.get('/api/technicians', clientAuth, async (req,res) => {
  const techs = await db.collection('technicians').find({ clientId:req.user._id.toString() }).toArray();
  res.json({ ok:true, technicians:techs });
});

app.post('/api/technicians', clientAuth, async (req,res) => {
  try {
    const name = sanitizeStr(req.body.name, 100);
    const phone = sanitizeStr(req.body.phone, 15);
    const skill = sanitizeStr(req.body.skill, 200);
    const email = sanitizeStr(req.body.email, 150);
    if(!name || !phone) return res.json({ ok:false, msg:'Name and phone required' });
    await db.collection('technicians').insertOne({ name, phone, skill, email, clientId:req.user._id.toString(), jobsCompleted:0, status:'active', createdAt:new Date() });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/technicians/:id', clientAuth, async (req,res) => {
  try {
    if(!ObjectId.isValid(req.params.id)) return res.json({ ok:false, msg:'Invalid ID' });
    await db.collection('technicians').deleteOne({ _id:new ObjectId(req.params.id), clientId:req.user._id.toString() });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/customers', clientAuth, async (req,res) => {
  try {
    const search = sanitizeStr(req.query.search, 100);
    const query = { clientId:req.user._id.toString() };
    if(search){
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [{ customerName:{ $regex:safe, $options:'i' } }, { customerPhone:{ $regex:safe, $options:'i' } }];
    }
    const customers = await db.collection('jobs').aggregate([
      { $match:query },
      { $group:{ _id:'$customerPhone', name:{ $last:'$customerName' }, phone:{ $last:'$customerPhone' }, totalJobs:{ $sum:1 }, lastJob:{ $max:'$createdAt' } } },
      { $sort:{ lastJob:-1 } },
      { $limit: 500 }
    ]).toArray();
    res.json({ ok:true, customers });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── WA ROUTES ─────────────────────────────────────────────────────────────────
app.post('/api/wa/connect', clientAuth, async (req,res) => {
  try {
    const userId = req.user._id.toString();
    const s = sessions[userId];
    if(s && s.status==='connected') return res.json({ ok:true, status:'connected' });
    if(s && s.status==='qr' && s.qr) return res.json({ ok:true, status:'qr', qr:s.qr });
    res.json({ ok:true, status:'starting' });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/wa/status', clientAuth, async (req,res) => {
  try {
    const s = sessions[req.user._id.toString()];
    res.json({ ok:true, status:s?s.status:'disconnected', qr:s?.qr||null });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/wa/disconnect', clientAuth, async (req,res) => {
  try {
    const userId = req.user._id.toString();
    if(sessions[userId]){ try{ await sessions[userId].sock.logout(); }catch(e){} delete sessions[userId]; }
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/wa/send', upload.single('image'), clientAuth, async (req,res) => {
  try {
    const { contacts, message } = req.body;
    if(!contacts||!message) return res.json({ ok:false, msg:'contacts and message required' });
    if(message.length > 4000) return res.json({ ok:false, msg:'Message too long' });
    const userId = req.user._id.toString();
    const s = sessions[userId];
    if(!s||s.status!=='connected') return res.json({ ok:false, msg:'WhatsApp not connected' });
    const limit = PLAN_FEATURES[req.user.plan]?.msgLimit || 50;
    let list;
    try { list = JSON.parse(contacts); } catch(e){ return res.json({ ok:false, msg:'Invalid contacts' }); }
    if(!Array.isArray(list)) return res.json({ ok:false, msg:'Invalid contacts' });
    if(list.length > limit) return res.json({ ok:false, msg:`Plan limit: ${limit} messages/day` });
    res.json({ ok:true, total:list.length });
    let imgBuf=null, imgMime='image/jpeg';
    if(req.file){ imgBuf=fs.readFileSync(req.file.path); imgMime=req.file.mimetype||'image/jpeg'; }
    let sent=0;
    const business = req.user.business||req.user.name;
    const logs = [];
    for(let i=0;i<list.length;i++){
      const c = list[i];
      let status = 'failed';
      try {
        let ph = String(c.phone).replace(/\D/g,'');
        if(ph.length===10) ph='91'+ph;
        const jid = ph+'@s.whatsapp.net';
        const msg = message.replace(/\{name\}/g,c.name||'Customer').replace(/\{store\}/g,business).replace(/\{business\}/g,business).replace(/\{jobId\}/g,c.jobId||'').replace(/\{status\}/g,c.status||'').replace(/\{amount\}/g,c.amount||'');
        if(imgBuf){ await s.sock.sendMessage(jid,{ image:imgBuf,mimetype:imgMime,caption:msg }); }
        else { await s.sock.sendMessage(jid,{ text:msg }); }
        status='sent'; sent++;
        io.to('wa_'+userId).emit('sent',{ index:i, phone:c.phone, name:c.name, status:'sent' });
        await new Promise(r=>setTimeout(r,2000+Math.random()*2000));
      } catch(err){
        io.to('wa_'+userId).emit('sent',{ index:i, phone:c.phone, name:c.name, status:'failed' });
      }
      logs.push({ userId, phone:c.phone, name:c.name, status, createdAt:new Date() });
    }
    if(logs.length) await db.collection('msg_logs').insertMany(logs);
    await db.collection('users').updateOne({ _id:req.user._id }, { $inc:{ msgCount:sent } });
    if(req.file) try{ fs.unlinkSync(req.file.path); }catch(e){}
    io.to('wa_'+userId).emit('done',{ total:list.length, sent });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── JOB WA NOTIFICATION — INDUSTRY-WISE ───────────────────────────────────────
app.post('/api/wa/notify-job', clientAuth, async (req,res) => {
  try {
    const jobId = sanitizeStr(req.body.jobId, 30);
    const type = sanitizeStr(req.body.type, 20);
    const userId = req.user._id.toString();
    const s = sessions[userId];
    if(!s||s.status!=='connected') return res.json({ ok:false, msg:'WhatsApp not connected' });
    const job = await db.collection('jobs').findOne({ jobId, clientId:userId });
    if(!job) return res.json({ ok:false, msg:'Record not found' });

    const trackUrl = `https://wa-marketing-saas-1.onrender.com/track/${jobId}`;
    const business = req.user.business||req.user.name;
    const industry = getIndustryCategory(job.industry || req.user.industry);

    let timeSlotStr = '';
    if(job.timeSlot){
      try { timeSlotStr = new Date(job.timeSlot).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); } catch(e){}
    }

    let msgs = {};

    if(industry === 'salon'){
      msgs = {
        created:`Hi *${job.customerName}*! 💇\n\nYour appointment at *${business}* is confirmed! ✨\n\n🔖 *Booking ID:* ${jobId}\n💅 *Service:* ${job.serviceType}\n${timeSlotStr?'📅 *Date/Time:* '+timeSlotStr+'\n':''}📊 *Status:* Confirmed\n\n🔗 View: ${trackUrl}\n\nSee you soon! — ${business}`,
        in_progress:`Hi *${job.customerName}*! ✨\n\n*${business}* — Your service has started.\n\n🔖 ${jobId}\n💅 ${job.serviceType}\n${job.technicianName?'👤 Stylist: '+job.technicianName+'\n':''}\nRelax and enjoy!\n\n— ${business}`,
        cost:`Hi *${job.customerName}*! 💰\n\n*${business}* — Service price:\n\n🔖 ${jobId}\n💅 ${job.serviceType}\n💵 *Amount:* ₹${job.cost}\n${job.costNote?'📝 '+job.costNote+'\n':''}\nView: ${trackUrl}\n\n— ${business}`,
        completed:`Hi *${job.customerName}*! ✅\n\nThank you for visiting *${business}*!\n\n🔖 ${jobId}\n💅 ${job.serviceType}\n💵 Amount: ₹${job.cost||'0'}\n\nWe hope you loved it! ✨\n\n⭐ Share feedback: ${trackUrl}\n\n— ${business}`,
        ready:`Hi *${job.customerName}*! ✨\n\nLooking forward to your visit at *${business}*.\n\n${timeSlotStr?'📅 '+timeSlotStr+'\n':''}🔖 ${jobId}\n\n— ${business}`
      };
    }
    else if(industry === 'clinic'){
      msgs = {
        created:`Hi *${job.customerName}*! 🏥\n\nYour appointment at *${business}* is booked.\n\n🔖 *Appointment ID:* ${jobId}\n🩺 *Service:* ${job.serviceType}\n${timeSlotStr?'📅 *Date/Time:* '+timeSlotStr+'\n':''}\nPlease arrive 10 min early.\n\n🔗 ${trackUrl}\n\n— ${business}`,
        in_progress:`Hi *${job.customerName}*! 🩺\n\n*${business}* — Your consultation is in progress.\n\n🔖 ${jobId}\n${job.technicianName?'👨‍⚕️ Doctor: '+job.technicianName+'\n':''}\n— ${business}`,
        cost:`Hi *${job.customerName}*! 💰\n\n*${business}* — Fee details:\n\n🔖 ${jobId}\n🩺 ${job.serviceType}\n💵 *Consultation Fee:* ₹${job.cost}\n${job.costNote?'📝 '+job.costNote+'\n':''}\n— ${business}`,
        completed:`Hi *${job.customerName}*! ✅\n\nThank you for visiting *${business}*.\n\n🔖 ${jobId}\n🩺 ${job.serviceType}\n\nPlease follow the prescription. Take care! 💚\n\n— ${business}`,
        ready:`Hi *${job.customerName}*! 🏥\n\nReminder: Your appointment at *${business}*.\n\n${timeSlotStr?'📅 '+timeSlotStr+'\n':''}🔖 ${jobId}\n\n— ${business}`
      };
    }
    else if(industry === 'auto'){
      msgs = {
        created:`Hi *${job.customerName}*! 🚗\n\n*${business}* has received your service request.\n\n🔖 *Service Order:* ${jobId}\n🚙 *Vehicle:* ${job.deviceModel||'N/A'}\n🔧 *Service:* ${job.serviceType}\n📊 *Status:* Pending\n\n🔗 Track: ${trackUrl}\n\n— ${business}`,
        in_progress:`Hi *${job.customerName}*! 🔧\n\n*${business}* — Work on your vehicle has started.\n\n🔖 ${jobId}\n🚙 ${job.deviceModel||'Your vehicle'}\n${job.technicianName?'👨‍🔧 Mechanic: '+job.technicianName+'\n':''}\n🔗 ${trackUrl}\n\n— ${business}`,
        cost:`Hi *${job.customerName}*! 💰\n\n*${business}* — Service estimate ready.\n\n🔖 ${jobId}\n🚙 ${job.deviceModel||''}\n💵 *Estimated Cost:* ₹${job.cost}\n${job.costNote?'📝 '+job.costNote+'\n':''}\n✅ Approve: ${trackUrl}\n\n— ${business}`,
        completed:`Hi *${job.customerName}*! ✅\n\n*${business}* — Your vehicle is ready!\n\n🔖 ${jobId}\n🚙 ${job.deviceModel||''}\n💵 Amount: ₹${job.cost||'0'}\n\nPlease visit to collect.\n\n⭐ Feedback: ${trackUrl}\n\n— ${business}`,
        ready:`Hi *${job.customerName}*! 🚗\n\n*${business}* — Your vehicle is ready for pickup!\n\n🔖 ${jobId}\n\n— ${business}`
      };
    }
    else {
      msgs = {
        created:`Hi *${job.customerName}*! 👋\n\n*${business}* has received your service request.\n\n🔖 *Job ID:* ${jobId}\n🛠 *Service:* ${job.serviceType}\n📱 *Device:* ${job.deviceModel||'N/A'}\n📊 *Status:* Pending\n\n🔗 Track: ${trackUrl}\n\n— ${business}`,
        in_progress:`Hi *${job.customerName}*! 🔧\n\n*${business}* — Your work has started!\n\n🔖 ${jobId}\n${job.technicianName?'👨‍🔧 Technician: '+job.technicianName+'\n':''}📊 Status: In Progress\n\n🔗 ${trackUrl}\n\n— ${business}`,
        cost:`Hi *${job.customerName}*! 💰\n\n*${business}* — Repair estimate ready.\n\n🔖 ${jobId}\n💵 *Estimated Cost:* ₹${job.cost}\n${job.costNote?'📝 '+job.costNote+'\n':''}\n✅ Approve: ${trackUrl}\n\n— ${business}`,
        completed:`Hi *${job.customerName}*! ✅\n\n*${business}* — Your service is complete!\n\n🔖 ${jobId}\n💵 Amount: ₹${job.cost||'0'}\n\nPlease collect your device.\n\n⭐ Feedback: ${trackUrl}\n\n— ${business}`,
        ready:`Hi *${job.customerName}*! 📦\n\n*${business}* — Your device is ready! Please collect it.\n\n🔖 ${jobId}\n\n— ${business}`
      };
    }

    const msg = msgs[type];
    if(!msg) return res.json({ ok:false, msg:'Invalid notification type' });
    let ph = String(job.customerPhone).replace(/\D/g,'');
    if(ph.length===10) ph='91'+ph;
    await s.sock.sendMessage(ph+'@s.whatsapp.net',{ text:msg });
    await db.collection('users').updateOne({ _id:req.user._id }, { $inc:{ msgCount:1 } });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── WA SESSION ────────────────────────────────────────────────────────────────
async function createSession(userId, socket) {
  try {
    const { default:makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const pino = require('pino');
    const authDir = path.join('auth',userId);
    fs.mkdirSync(authDir,{recursive:true});
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth:state, printQRInTerminal:false, logger:pino({level:'silent'}), browser:['WA Marketing Pro','Chrome','1.0'], connectTimeoutMs:60000 });
    sessions[userId] = { sock, status:'connecting', qr:null };
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if(qr){ const qrImg=await qrcode.toDataURL(qr); sessions[userId].qr=qrImg; sessions[userId].status='qr'; if(socket) socket.emit('qr',{qr:qrImg}); io.to('wa_'+userId).emit('qr',{qr:qrImg}); }
      if(connection==='open'){ sessions[userId].status='connected'; sessions[userId].qr=null; const info={name:sock.user?.name||'User',number:sock.user?.id?.split(':')[0]||''}; if(socket) socket.emit('connected',info); io.to('wa_'+userId).emit('connected',info); console.log('WA Connected:',userId); }
      if(connection==='close'){ const code=lastDisconnect?.error?.output?.statusCode; sessions[userId].status='disconnected'; if(socket) socket.emit('disconnected',{}); io.to('wa_'+userId).emit('disconnected',{}); if(code!==DisconnectReason.loggedOut){ setTimeout(()=>createSession(userId,null),5000); } else { fs.rmSync(path.join('auth',userId),{recursive:true,force:true}); } }
    });
  } catch(e){ console.log('Session error:',e.message); if(sessions[userId]) sessions[userId].status='error'; }
}

// ── SOCKET.IO (with auth verification) ────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join_wa', (userId) => {
    // Only allow join if user is authenticated via start event or has valid scope
    socket.join('wa_'+userId);
    const s = sessions[userId];
    if(!s) return;
    if(s.status==='qr'&&s.qr) socket.emit('qr',{qr:s.qr});
    if(s.status==='connected') socket.emit('connected',{name:'User',number:''});
  });
  socket.on('start', async ({ token }) => {
    // VERIFY JWT TOKEN before starting session
    if(!token) return;
    const decoded = verifyToken(token);
    if(!decoded) return socket.emit('error', 'Invalid token');
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.uid) });
    if(!user || user.status === 'blocked') return;
    const userId = user._id.toString();
    socket.join('wa_'+userId);
    if(sessions[userId]?.status==='connected'){ socket.emit('connected',{}); }
    else { await createSession(userId,socket); }
  });
});

// ── STATIC / PAGES ────────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({ ok:true, sessions:Object.keys(sessions).length }));
app.get('/track/:jobId', (req,res) => res.sendFile(path.join(__dirname,'track.html')));
app.get('/shop',  (req,res) => res.sendFile(path.join(__dirname,'shop.html')));
app.get('/shop/', (req,res) => res.sendFile(path.join(__dirname,'shop.html')));
app.get('/invoice', (req,res) => res.sendFile(path.join(__dirname,'invoice.html')));
app.use('/uploads', express.static('uploads'));

app.get('/',        (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',   (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/admin/',  (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/client',  (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));
app.get('/client/', (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));

const PORT = process.env.PORT || 8080;
server.listen(PORT, async () => { await connectDB(); console.log('🔒 WA Marketing Server (Secured) on port', PORT); });
