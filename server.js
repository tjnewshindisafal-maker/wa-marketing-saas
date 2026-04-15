globalThis.crypto = require('crypto');

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const qrcode     = require('qrcode');
const { MongoClient, ObjectId } = require('mongodb');

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://waadmin:Waadmin2025@cluster0.0krvn5v.mongodb.net/wamarketing';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 75000,
      family: 4
    });
    await client.connect();
    db = client.db('wamarketing');
    console.log('MongoDB connected');
    await initAdmin();
  } catch(e) {
    console.error('MongoDB error:', e.message);
  }
}

async function initAdmin() {
  try {
    const users = db.collection('users');
    const admin = await users.findOne({ role: 'admin' });
    if (!admin) {
      await users.insertOne({
        name: 'Admin', email: 'admin@advizrmedia.in',
        pass: 'Advizr@2025', role: 'admin',
        status: 'active', plan: 'admin', createdAt: new Date()
      });
      console.log('Admin created');
    } else {
      await users.updateOne({ role:'admin' }, { $set:{ pass:'Advizr@2025', status:'active' } });
      console.log('Admin updated');
    }
  } catch(e) { console.log('initAdmin error:', e.message); }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const upload = multer({ dest:'uploads/', limits:{ fileSize:50*1024*1024 } });
fs.mkdirSync('uploads', { recursive:true });
fs.mkdirSync('auth',    { recursive:true });

// ── Sessions (declared early!) ────────────────────────────────────────────────
const sessions = {};

function genToken(id) {
  return Buffer.from(id+':'+Date.now()+':'+Math.random().toString(36)).toString('base64');
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, pass, phone, industry, plan } = req.body;
    const users = db.collection('users');
    if(await users.findOne({ email })) return res.json({ ok:false, msg:'Email already registered' });
    const token = genToken(email);
    await users.insertOne({
      name, email, pass, phone,
      industry: industry||'General',
      plan: plan||'starter',
      role: 'user', status: 'active', token,
      msgCount: 0,
      createdAt: new Date(),
      trialEnds: new Date(Date.now()+7*24*60*60*1000)
    });
    res.json({ ok:true, token, name, plan:plan||'starter' });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, pass } = req.body;
    const user = await db.collection('users').findOne({ email, pass });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });
    if(user.status==='blocked') return res.json({ ok:false, msg:'Account suspended.' });
    const token = genToken(user._id.toString());
    await db.collection('users').updateOne({ _id:user._id }, { $set:{ token, lastLogin:new Date() } });
    res.json({ ok:true, token, name:user.name, role:user.role, plan:user.plan });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const token = req.headers['x-token'];
    if(!token) return res.json({ ok:false, msg:'No token' });
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Invalid token' });
    res.json({ ok:true, user:{ id:user._id, name:user.name, email:user.email, role:user.role, plan:user.plan, business:user.business, industry:user.industry, msgCount:user.msgCount||0 } });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
async function adminAuth(req, res, next) {
  const token = req.headers['x-token'];
  if(!token) return res.json({ ok:false, msg:'No token' });
  const user = await db.collection('users').findOne({ token, role:'admin' });
  if(!user) return res.json({ ok:false, msg:'Unauthorized' });
  req.admin = user; next();
}

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, pass } = req.body;
    const user = await db.collection('users').findOne({ email, pass, role:'admin' });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });
    const token = genToken('admin');
    await db.collection('users').updateOne({ _id:user._id }, { $set:{ token } });
    res.json({ ok:true, token });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await db.collection('users').find({ role:{ $ne:'admin' } }).toArray();
  res.json({ ok:true, users });
});

app.post('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { name, email, pass, phone, plan, biz, industry } = req.body;
    if(await db.collection('users').findOne({ email })) return res.json({ ok:false, msg:'Email exists' });
    const token = genToken(email);
    await db.collection('users').insertOne({
      name, email, pass, phone,
      business: biz||name,
      industry: industry||'general',
      plan: plan||'starter',
      role: 'user', status: 'active', token,
      msgCount: 0, createdAt: new Date()
    });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').updateOne(
      { _id:new ObjectId(req.params.id) },
      { $set: req.body }
    );
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').deleteOne({ _id:new ObjectId(req.params.id) });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/approve/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:{ status:'active' } });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/block/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:{ status:'blocked' } });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/admin/plan/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:{ plan:req.body.plan } });
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const total   = await db.collection('users').countDocuments({ role:'user' });
    const active  = await db.collection('users').countDocuments({ role:'user', status:'active' });
    const blocked = await db.collection('users').countDocuments({ role:'user', status:'blocked' });
    const pro     = await db.collection('users').countDocuments({ role:'user', plan:'pro' });
    res.json({ ok:true, total, active, blocked, pro });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── WA HTTP ROUTES ────────────────────────────────────────────────────────────
app.post('/api/wa/connect', async (req, res) => {
  try {
    const token = req.headers['x-token'];
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Unauthorized' });
    const userId = user._id.toString();
    const s = sessions[userId];
    if(s && s.status==='connected') return res.json({ ok:true, status:'connected' });
    if(s && s.status==='qr' && s.qr) return res.json({ ok:true, status:'qr', qr:s.qr });
    res.json({ ok:true, status:'starting' });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/api/wa/status', async (req, res) => {
  try {
    const token = req.headers['x-token'];
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Unauthorized' });
    const userId = user._id.toString();
    const s = sessions[userId];
    res.json({ ok:true, status:s?s.status:'disconnected', qr:s?.qr||null });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/wa/disconnect', async (req, res) => {
  try {
    const token = req.headers['x-token'];
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Unauthorized' });
    const userId = user._id.toString();
    if(sessions[userId]){
      try{ await sessions[userId].sock.logout(); }catch(e){}
      delete sessions[userId];
    }
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── WA SESSION ────────────────────────────────────────────────────────────────
async function createSession(userId, socket) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
  const pino = require('pino');
  const authDir = path.join('auth', userId);
  fs.mkdirSync(authDir, { recursive:true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth:state,
    printQRInTerminal: false,
    logger: pino({ level:'silent' }),
    browser: ['WA Marketing Pro','Chrome','1.0'],
    connectTimeoutMs: 60000
  });

  sessions[userId] = { sock, status:'connecting', qr:null };
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if(qr) {
      const qrImg = await qrcode.toDataURL(qr);
      sessions[userId].qr = qrImg;
      sessions[userId].status = 'qr';
      if(socket) socket.emit('qr', { qr:qrImg });
      io.to('wa_'+userId).emit('qr', { qr:qrImg });
    }
    if(connection==='open') {
      sessions[userId].status = 'connected';
      sessions[userId].qr = null;
      const info = { name:sock.user?.name||'User', number:sock.user?.id?.split(':')[0]||'' };
      if(socket) socket.emit('connected', info);
      io.to('wa_'+userId).emit('connected', info);
      console.log('WA Connected:', userId);
    }
    if(connection==='close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessions[userId].status = 'disconnected';
      if(socket) socket.emit('disconnected', {});
      io.to('wa_'+userId).emit('disconnected', {});
      if(code !== DisconnectReason.loggedOut) {
        setTimeout(() => createSession(userId, null), 5000);
      } else {
        fs.rmSync(authDir, { recursive:true, force:true });
      }
    }
  });
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join_wa', (userId) => {
    socket.join('wa_'+userId);
    const s = sessions[userId];
    if(!s) return;
    if(s.status==='qr' && s.qr) socket.emit('qr', { qr:s.qr });
    if(s.status==='connected') socket.emit('connected', { name:'User', number:'' });
  });

  socket.on('start', async ({ token }) => {
    const user = await db.collection('users').findOne({ token });
    if(!user) return socket.emit('error', { msg:'Invalid token' });
    const userId = user._id.toString();
    socket.join('wa_'+userId);
    if(sessions[userId]?.status==='connected') {
      socket.emit('connected', { name:'User', number:'' });
    } else {
      await createSession(userId, socket);
    }
  });
});

// ── SEND ──────────────────────────────────────────────────────────────────────
app.post('/api/wa/send', upload.single('image'), async (req, res) => {
  try {
    const token = req.headers['x-token'];
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Unauthorized' });
    const { contacts, message } = req.body;
    if(!contacts||!message) return res.json({ ok:false, msg:'contacts and message required' });
    const userId = user._id.toString();
    const s = sessions[userId];
    if(!s||s.status!=='connected') return res.json({ ok:false, msg:'WhatsApp not connected' });

    const LIMITS = { starter:50, pro:200, business:500, trial:20 };
    const limit = LIMITS[user.plan]||50;
    let list = JSON.parse(contacts);
    if(list.length > limit) return res.json({ ok:false, msg:'Plan limit exceeded' });

    res.json({ ok:true, total:list.length });

    let imgBuf=null, imgMime='image/jpeg';
    if(req.file){ imgBuf=fs.readFileSync(req.file.path); imgMime=req.file.mimetype||'image/jpeg'; }

    let sent=0;
    const business = user.business||user.name;
    for(let i=0;i<list.length;i++){
      const c = list[i];
      try{
        let ph = String(c.phone).replace(/\D/g,'');
        if(ph.length===10) ph='91'+ph;
        const jid = ph+'@s.whatsapp.net';
        const msg = message.replace(/\{name\}/g,c.name||'Customer').replace(/\{store\}/g,business).replace(/\{business\}/g,business);
        if(imgBuf){
          await s.sock.sendMessage(jid, { image:imgBuf, mimetype:imgMime, caption:msg });
        } else {
          await s.sock.sendMessage(jid, { text:msg });
        }
        io.to('wa_'+userId).emit('sent', { index:i, phone:c.phone, name:c.name, status:'sent' });
        sent++;
        await new Promise(r => setTimeout(r, 1500+Math.random()*1500));
      } catch(err){
        io.to('wa_'+userId).emit('sent', { index:i, phone:c.phone, name:c.name, status:'failed' });
      }
    }
    await db.collection('users').updateOne({ _id:user._id }, { $inc:{ msgCount:sent } });
    if(req.file) try{ fs.unlinkSync(req.file.path); }catch(e){}
    io.to('wa_'+userId).emit('done', { total:list.length, sent });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// Health
app.get('/health', (req, res) => res.json({ ok:true, sessions:Object.keys(sessions).length }));

// ── PAGE ROUTES ───────────────────────────────────────────────────────────────
app.get('/',        (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',   (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/admin/',  (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/client',  (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));
app.get('/client/', (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, async () => {
  await connectDB();
  console.log('WA Marketing Server on port', PORT);
});
