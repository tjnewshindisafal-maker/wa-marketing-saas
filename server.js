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

// ── MongoDB ──────────────────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://waadmin:S%40ndeep9821@cluster0.0krvn5v.mongodb.net/?appName=Cluster0';
const DB_NAME   = 'wamarketing';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, {
  tls: true,
  tlsInsecure: false,
  serverSelectionTimeoutMS: 5000
});
    await client.connect();
    db = client.db(DB_NAME);
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
        id: 'admin_1',
        name: 'Admin',
        email: 'admin@advizrmedia.in',
        pass: 'Advizr@2025',
        role: 'admin',
        status: 'active',
        plan: 'admin',
        createdAt: new Date()
      });
      console.log('Admin created');
    } else {
      await users.updateOne(
        { role: 'admin' },
        { $set: { pass: 'Advizr@2025', status: 'active' } }
      );
      console.log('Admin updated');
    }
  } catch(e) {
    console.log('initAdmin error:', e.message);
  }
}

// ── Express ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
fs.mkdirSync('uploads', { recursive: true });
fs.mkdirSync('auth',    { recursive: true });

// ── Token helpers ─────────────────────────────────────────────────────────────
function genToken(id) {
  return Buffer.from(id + ':' + Date.now() + ':' + Math.random().toString(36)).toString('base64');
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, pass, phone, industry, plan } = req.body;
    const users = db.collection('users');
    const existing = await users.findOne({ email });
    if (existing) return res.json({ ok: false, msg: 'Email already registered' });
    const token = genToken(email);
    await users.insertOne({
      name, email, pass, phone,
      industry: industry || 'General',
      plan: plan || 'trial',
      role: 'user',
      status: 'active',
      token,
      createdAt: new Date(),
      trialEnds: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    res.json({ ok: true, token, name, plan: plan || 'trial' });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, pass } = req.body;
    const users = db.collection('users');
    const user = await users.findOne({ email, pass });
    if (!user) return res.json({ ok: false, msg: 'Wrong email or password!' });
    if (user.status === 'blocked') return res.json({ ok: false, msg: 'Account suspended. Contact support.' });
    const token = genToken(user._id.toString());
    await users.updateOne({ _id: user._id }, { $set: { token, lastLogin: new Date() } });
    res.json({ ok: true, token, name: user.name, role: user.role, plan: user.plan });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

async function adminAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.json({ ok: false, msg: 'No token' });
  const user = await db.collection('users').findOne({ token, role: 'admin' });
  if (!user) return res.json({ ok: false, msg: 'Unauthorized' });
  req.admin = user;
  next();
}

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, pass } = req.body;
    const user = await db.collection('users').findOne({ email, pass, role: 'admin' });
    if (!user) return res.json({ ok: false, msg: 'Wrong email or password!' });
    const token = genToken('admin');
    await db.collection('users').updateOne({ _id: user._id }, { $set: { token } });
    res.json({ ok: true, token });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Get all users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await db.collection('users').find({ role: { $ne: 'admin' } }).toArray();
  res.json({ ok: true, users });
});

// Add user
app.post('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { name, email, pass, phone, plan } = req.body;
    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.json({ ok: false, msg: 'Email already exists' });
    const token = genToken(email);
    await db.collection('users').insertOne({
      name, email, pass, phone,
      plan: plan || 'pro',
      role: 'user',
      status: 'active',
      token,
      createdAt: new Date()
    });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Update user
app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const { name, email, pass, plan, status } = req.body;
    await db.collection('users').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name, email, pass, plan, status } }
    );
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Delete user
app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await db.collection('users').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const total   = await db.collection('users').countDocuments({ role: 'user' });
    const active  = await db.collection('users').countDocuments({ role: 'user', status: 'active' });
    const blocked = await db.collection('users').countDocuments({ role: 'user', status: 'blocked' });
    const pro     = await db.collection('users').countDocuments({ role: 'user', plan: 'pro' });
    res.json({ ok: true, total, active, blocked, pro });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── WHATSAPP SESSIONS ─────────────────────────────────────────────────────────
const sessions = {};

async function createSession(userId, socket) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
  const authDir = path.join('auth', userId);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['WA Marketing Pro', 'Chrome', '1.0']
  });

  sessions[userId] = { sock, status: 'connecting' };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrImg = await qrcode.toDataURL(qr);
      if (socket) socket.emit('qr', { qr: qrImg });
      sessions[userId].status = 'qr';
    }
    if (connection === 'open') {
      sessions[userId].status = 'connected';
      sessions[userId].user = sock.user;
      if (socket) socket.emit('connected', { user: sock.user.id });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessions[userId].status = 'disconnected';
      if (socket) socket.emit('disconnected', {});
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => createSession(userId, null), 5000);
      } else {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    }
  });
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('start', async ({ token }) => {
    const user = await db.collection('users').findOne({ token });
    if (!user) return socket.emit('error', { msg: 'Invalid token' });
    const userId = user._id.toString();
    socket.userId = userId;
    if (sessions[userId] && sessions[userId].status === 'connected') {
      socket.emit('connected', { user: sessions[userId].user?.id });
    } else {
      await createSession(userId, socket);
    }
  });

  socket.on('status', ({ token }) => {
    db.collection('users').findOne({ token }).then(user => {
      if (!user) return;
      const s = sessions[user._id.toString()];
      socket.emit('status', { status: s ? s.status : 'disconnected' });
    });
  });
});

// ── SEND MESSAGE ──────────────────────────────────────────────────────────────
app.post('/api/send', upload.single('image'), async (req, res) => {
  try {
    const { token, phone, message } = req.body;
    const user = await db.collection('users').findOne({ token });
    if (!user) return res.json({ ok: false, msg: 'Invalid token' });

    const userId = user._id.toString();
    const s = sessions[userId];
    if (!s || s.status !== 'connected') return res.json({ ok: false, msg: 'WhatsApp not connected' });

    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    if (req.file) {
      const imgBuf = fs.readFileSync(req.file.path);
      await s.sock.sendMessage(jid, { image: imgBuf, caption: message });
      fs.unlinkSync(req.file.path);
    } else {
      await s.sock.sendMessage(jid, { text: message });
    }

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

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
  console.log('WA Marketing Server on port ' + PORT);
});
