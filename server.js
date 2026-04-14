globalThis.crypto = require('crypto');

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const qrcode   = require('qrcode');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, transports: ['polling','websocket'] });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve pages
app.get('/',           (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/client',     (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));
app.get('/admin',      (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));

const upload = multer({ dest:'uploads/', limits:{ fileSize: 50*1024*1024 } });

// ── DATABASE (JSON file - simple, no MongoDB needed) ─────────────────────────
const DB_FILE = 'db.json';
function readDB(){
  try{ return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
  catch(e){ return { users:[], payments:[] }; }
}
function writeDB(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// Init admin
function initDB(){
  const db = readDB();
  if(!db.users.find(u => u.role==='admin')){
    db.users.push({
      id: 'admin_1',
      name: 'Admin',
      email: 'admin@advizrmedia.in',
      pass: 'Advizr@2025',
      role: 'admin',
      status: 'active',
      plan: 'admin',
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    console.log('Admin user created');
  }
}

// ── AUTH HELPERS ──────────────────────────────────────────────────────────────
function genToken(userId){
  const payload = userId + ':' + Date.now() + ':' + Math.random().toString(36);
  return Buffer.from(payload).toString('base64');
}

function verifyToken(token, db){
  if(!token) return null;
  return db.users.find(u => u.token === token && u.status === 'active');
}

// ── WHATSAPP SESSIONS ─────────────────────────────────────────────────────────
const waSessions = {};

async function createWASession(userId){
  if(waSessions[userId] && ['ready','qr_ready','initializing'].includes(waSessions[userId].status)){
    return waSessions[userId];
  }

  waSessions[userId] = { sock:null, status:'initializing', qr:null, info:null };
  const authDir = path.join('auth', userId);
  if(!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive:true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version, auth:state,
      printQRInTerminal: false,
      logger: pino({ level:'silent' }),
      browser: ['Chrome (Linux)','',''],
      connectTimeoutMs: 60000
    });

    waSessions[userId].sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if(qr){
        const qrImg = await qrcode.toDataURL(qr);
        waSessions[userId].qr     = qrImg;
        waSessions[userId].status = 'qr_ready';
        io.to('wa_'+userId).emit('qr', { qr: qrImg });
        console.log('QR ready:', userId);
      }

      if(connection === 'open'){
        waSessions[userId].status = 'ready';
        waSessions[userId].qr     = null;
        const user = sock.user;
        waSessions[userId].info   = user;
        const name   = user.name || user.notify || 'User';
        const number = user.id ? user.id.split(':')[0] : '';
        io.to('wa_'+userId).emit('ready', { name, number });
        console.log('WA Connected:', userId, name);

        // Update DB
        const db = readDB();
        const u = db.users.find(u => u.id === userId);
        if(u){ u.waName = name; u.waNumber = number; u.waConnected = true; writeDB(db); }
      }

      if(connection === 'close'){
        const code = lastDisconnect?.error?.output?.statusCode;
        if(code !== DisconnectReason.loggedOut && waSessions[userId]){
          waSessions[userId].status = 'reconnecting';
          setTimeout(() => createWASession(userId), 5000);
        } else {
          if(waSessions[userId]) waSessions[userId].status = 'disconnected';
          io.to('wa_'+userId).emit('disconnected');
          const db = readDB();
          const u = db.users.find(u => u.id === userId);
          if(u){ u.waConnected = false; writeDB(db); }
        }
      }
    });

  } catch(e) {
    console.log('WA Session error:', e.message);
    waSessions[userId].status = 'error';
  }

  return waSessions[userId];
}

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join_wa', (userId) => {
    socket.join('wa_'+userId);
    const s = waSessions[userId];
    if(!s) return;
    if(s.status==='qr_ready' && s.qr) socket.emit('qr', { qr:s.qr });
    if(s.status==='ready' && s.info) socket.emit('ready', {
      name: s.info.name||'User',
      number: s.info.id ? s.info.id.split(':')[0] : ''
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Login
app.post('/api/auth/login', (req,res) => {
  const { email, pass } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email===email && u.pass===pass);
  if(!user) return res.json({ error:'Wrong email or password' });
  if(user.status==='pending') return res.json({ error:'Account pending approval' });
  if(user.status==='blocked') return res.json({ error:'Account suspended' });
  const token = genToken(user.id);
  user.token = token;
  user.lastLogin = new Date().toISOString();
  writeDB(db);
  res.json({ success:true, token, user:{ id:user.id, name:user.name, email:user.email, role:user.role, plan:user.plan, business:user.business, industry:user.industry } });
});

// Register (pending approval)
app.post('/api/auth/register', (req,res) => {
  const { name, email, pass, business, industry, phone, plan } = req.body;
  if(!name||!email||!pass||!phone) return res.json({ error:'All fields required' });
  const db = readDB();
  if(db.users.find(u => u.email===email)) return res.json({ error:'Email already registered' });
  const user = {
    id: 'usr_'+Date.now(),
    name, email, pass, business:business||name,
    industry: industry||'general', phone,
    plan: plan||'starter',
    role: 'client',
    status: 'pending',
    waConnected: false,
    msgCount: 0,
    createdAt: new Date().toISOString(),
    paymentProof: null
  };
  db.users.push(user);
  writeDB(db);
  res.json({ success:true, message:'Registration successful. Wait for admin approval.' });
});

// Me
app.get('/api/auth/me', (req,res) => {
  const token = req.headers.authorization?.replace('Bearer ','');
  const db = readDB();
  const user = verifyToken(token, db);
  if(!user) return res.json({ error:'Unauthorized' });
  res.json({ user:{ id:user.id, name:user.name, email:user.email, role:user.role, plan:user.plan, business:user.business, industry:user.industry, waConnected:user.waConnected, waName:user.waName, waNumber:user.waNumber, msgCount:user.msgCount } });
});

// ════════════════════════════════════════════════════════════════════════════
// CLIENT ROUTES
// ════════════════════════════════════════════════════════════════════════════

// WA Connect
app.post('/api/wa/connect', async (req,res) => {
  const token = req.headers.authorization?.replace('Bearer ','');
  const db = readDB();
  const user = verifyToken(token, db);
  if(!user) return res.json({ error:'Unauthorized' });
  const s = await createWASession(user.id);
  res.json({ status:s.status, qr:s.qr });
});

// WA Status
app.get('/api/wa/status', (req,res) => {
  const token = req.headers.authorization?.replace('Bearer ','');
  const db = readDB();
  const user = verifyToken(token, db);
  if(!user) return res.json({ error:'Unauthorized' });
  const s = waSessions[user.id];
  if(!s) return res.json({ status:'not_started' });
  res.json({ status:s.status, qr:s.qr });
});

// WA Disconnect
app.post('/api/wa/disconnect', async (req,res) => {
  const token = req.headers.authorization?.replace('Bearer ','');
  const db = readDB();
  const user = verifyToken(token, db);
  if(!user) return res.json({ error:'Unauthorized' });
  if(waSessions[user.id]?.sock){
    try{ await waSessions[user.id].sock.logout(); }catch(e){}
    delete waSessions[user.id];
  }
  user.waConnected = false; writeDB(db);
  res.json({ success:true });
});

// Send Messages
app.post('/api/wa/send', upload.single('image'), async (req,res) => {
  const token = req.headers.authorization?.replace('Bearer ','');
  const db = readDB();
  const user = verifyToken(token, db);
  if(!user) return res.json({ error:'Unauthorized' });

  const { contacts, message } = req.body;
  const imageFile = req.file;
  if(!contacts||!message) return res.json({ error:'contacts and message required' });

  const s = waSessions[user.id];
  if(!s||s.status!=='ready') return res.json({ error:'WhatsApp not connected' });

  let list = [];
  try{ list = JSON.parse(contacts); }catch(e){ return res.json({ error:'Invalid contacts' }); }

  // Check plan limits
  const LIMITS = { starter:50, pro:200, business:500 };
  const limit  = LIMITS[user.plan] || 50;
  if(list.length > limit) return res.json({ error:'Plan limit exceeded. Upgrade to send more.' });

  res.json({ success:true, total:list.length });

  let imgBuf=null, imgMime='image/jpeg';
  if(imageFile){ imgBuf=fs.readFileSync(imageFile.path); imgMime=imageFile.mimetype||'image/jpeg'; }

  let sent=0;
  for(let i=0;i<list.length;i++){
    const c = list[i];
    try{
      let ph = String(c.phone).replace(/\D/g,'');
      if(ph.length===10) ph='91'+ph;
      const jid = ph+'@s.whatsapp.net';
      const store = user.business || user.name;
      const msg = message
        .replace(/\{name\}/g,  c.name||'Customer')
        .replace(/\{store\}/g, store)
        .replace(/\{business\}/g, store);

      if(imgBuf){
        await s.sock.sendMessage(jid, { image:imgBuf, mimetype:imgMime, caption:msg });
      } else {
        await s.sock.sendMessage(jid, { text:msg });
      }

      io.to('wa_'+user.id).emit('sent', { index:i, phone:c.phone, name:c.name, status:'sent' });
      sent++;
      await new Promise(r => setTimeout(r, 1500+Math.random()*1500));
    } catch(err){
      io.to('wa_'+user.id).emit('sent', { index:i, phone:c.phone, name:c.name, status:'failed' });
    }
  }

  // Update msg count
  user.msgCount = (user.msgCount||0) + sent;
  writeDB(db);

  if(imageFile) try{ fs.unlinkSync(imageFile.path); }catch(e){}
  io.to('wa_'+user.id).emit('done', { total:list.length, sent });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════════════════════

function isAdmin(req, db){
  const token = req.headers.authorization?.replace('Bearer ','');
  const user = verifyToken(token, db);
  return user && user.role==='admin' ? user : null;
}

// Get all users
app.get('/api/admin/users', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  res.json({ users: db.users.filter(u => u.role!=='admin') });
});

// Approve user
app.post('/api/admin/approve/:id', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  const user = db.users.find(u => u.id===req.params.id);
  if(!user) return res.json({ error:'User not found' });
  user.status = 'active';
  user.approvedAt = new Date().toISOString();
  writeDB(db);
  res.json({ success:true });
});

// Block user
app.post('/api/admin/block/:id', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  const user = db.users.find(u => u.id===req.params.id);
  if(!user) return res.json({ error:'User not found' });
  user.status = 'blocked';
  writeDB(db);
  res.json({ success:true });
});

// Update plan
app.post('/api/admin/plan/:id', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  const user = db.users.find(u => u.id===req.params.id);
  if(!user) return res.json({ error:'User not found' });
  user.plan = req.body.plan;
  writeDB(db);
  res.json({ success:true });
});

// Delete user
app.delete('/api/admin/user/:id', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  db.users = db.users.filter(u => u.id!==req.params.id);
  writeDB(db);
  res.json({ success:true });
});

// Add user manually
app.post('/api/admin/add-user', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  const { name, email, pass, business, industry, phone, plan } = req.body;
  if(!name||!email||!pass) return res.json({ error:'name, email, pass required' });
  if(db.users.find(u => u.email===email)) return res.json({ error:'Email exists' });
  const user = {
    id:'usr_'+Date.now(), name, email, pass,
    business:business||name, industry:industry||'general',
    phone:phone||'', plan:plan||'starter',
    role:'client', status:'active',
    waConnected:false, msgCount:0,
    createdAt:new Date().toISOString()
  };
  db.users.push(user);
  writeDB(db);
  res.json({ success:true, user });
});

// Stats
app.get('/api/admin/stats', (req,res) => {
  const db = readDB();
  if(!isAdmin(req,db)) return res.json({ error:'Unauthorized' });
  const clients = db.users.filter(u => u.role!=='admin');
  res.json({
    total:    clients.length,
    active:   clients.filter(u=>u.status==='active').length,
    pending:  clients.filter(u=>u.status==='pending').length,
    blocked:  clients.filter(u=>u.status==='blocked').length,
    starter:  clients.filter(u=>u.plan==='starter').length,
    pro:      clients.filter(u=>u.plan==='pro').length,
    business: clients.filter(u=>u.plan==='business').length,
    totalMsg: clients.reduce((a,u)=>a+(u.msgCount||0),0)
  });
});

// Health
app.get('/health', (req,res) => res.json({ status:'ok', sessions:Object.keys(waSessions).length }));

// Start
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log('WA SaaS Server on port', PORT);
  ['uploads','auth'].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d); });
  initDB();
});
