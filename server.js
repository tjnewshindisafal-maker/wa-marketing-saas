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

const MONGO_URI = 'mongodb+srv://waadmin:Waadmin2025@cluster0.0krvn5v.mongodb.net/wamarketing';
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS:30000, socketTimeoutMS:75000, family:4 });
    await client.connect();
    db = client.db('wamarketing');
    console.log('MongoDB connected');
    await initAdmin();
    startScheduler();
    startTrialChecker();
  } catch(e) { console.error('MongoDB error:', e.message); }
}

async function initAdmin() {
  try {
    const users = db.collection('users');
    const admin = await users.findOne({ role:'admin' });
    if(!admin){
      await users.insertOne({ name:'Admin', email:'admin@advizrmedia.in', pass:'Advizr@2025', role:'admin', status:'active', plan:'admin', createdAt:new Date() });
      console.log('Admin created');
    } else {
      await users.updateOne({ role:'admin' }, { $set:{ pass:'Advizr@2025', status:'active' } });
      console.log('Admin updated');
    }
  } catch(e) { console.log('initAdmin error:', e.message); }
}

// ── TRIAL CHECKER ─────────────────────────────────────────────────────────────
function startTrialChecker() {
  // Every hour, downgrade expired trials to starter
  setInterval(async () => {
    try {
      const now = new Date();
      const result = await db.collection('users').updateMany(
        { isTrial:true, trialEnds:{ $lte:now }, plan:{ $ne:'starter' } },
        { $set:{ plan:'starter', isTrial:false, trialExpired:true, trialExpiredAt:now } }
      );
      if(result.modifiedCount > 0) console.log('Trial expired for', result.modifiedCount, 'users');
    } catch(e){ console.log('Trial check error:', e.message); }
  }, 60*60*1000); // Every hour
  console.log('Trial checker started');
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
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
  }, 60000); // Check every minute
  console.log('Scheduler started');
}

// ── Job ID Generator ──────────────────────────────────────────────────────────
async function generateJobId(clientId) {
  const count = await db.collection('jobs').countDocuments({ clientId });
  return 'JOB-'+String(count+1001).padStart(4,'0');
}

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname,'public')));

const storage = multer.diskStorage({
  destination:(req,file,cb) => { const d='uploads/jobs'; fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb) => cb(null, Date.now()+'-'+file.originalname)
});
const upload = multer({ storage, limits:{ fileSize:50*1024*1024 } });
fs.mkdirSync('uploads/jobs',{recursive:true});
fs.mkdirSync('auth',{recursive:true});

const sessions = {};
function genToken(id){ return Buffer.from(id+':'+Date.now()+':'+Math.random().toString(36)).toString('base64'); }

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

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/signup', async (req,res) => {
  try {
    const { name,email,pass,phone,industry,plan,business } = req.body;
    if(await db.collection('users').findOne({ email })) return res.json({ ok:false, msg:'Email already registered' });
    const token = genToken(email);
    const planFinal = plan || 'starter';
    const isPaidPlan = planFinal !== 'starter';
    await db.collection('users').insertOne({
      name, email, pass, phone, business:business||name,
      industry:industry||'General', plan:planFinal,
      role:'user', status:'active', token,
      isTrial: isPaidPlan,
      trialEnds: isPaidPlan ? new Date(Date.now()+7*24*60*60*1000) : null,
      msgCount:0, jobCount:0, createdAt:new Date()
    });
    res.json({ ok:true, token, name, plan:planFinal });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/login', async (req,res) => {
  try {
    const { email,pass } = req.body;
    const user = await db.collection('users').findOne({ email,pass });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });
    if(user.status==='blocked') return res.json({ ok:false, msg:'Account suspended.' });
    const token = genToken(user._id.toString());
    await db.collection('users').updateOne({ _id:user._id }, { $set:{ token, lastLogin:new Date() } });
    res.json({ ok:true, token, name:user.name, role:user.role, plan:user.plan, business:user.business });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── GOOGLE LOGIN ──────────────────────────────────────────────────────────────
app.post('/api/google-login', async (req,res) => {
  try {
    const { credential } = req.body;
    if(!credential) return res.json({ ok:false, msg:'No credential' });
    // Decode Google JWT (client-side token)
    const payload = JSON.parse(Buffer.from(credential.split('.')[1],'base64').toString());
    if(!payload.email) return res.json({ ok:false, msg:'Invalid token' });
    const email = payload.email.toLowerCase();
    const name  = payload.name || email.split('@')[0];

    let user = await db.collection('users').findOne({ email });
    if(!user){
      // New user — auto signup with selected plan + 7-day trial if paid
      const token = genToken(email);
      const plan = (req.body.plan || 'starter').toString();
      const phone = (req.body.phone || '').toString();
      const business = (req.body.business || name).toString();
      const isPaidPlan = plan !== 'starter';
      const doc = {
        name, email, pass:'', phone, business,
        industry:'General', plan,
        role:'user', status:'active', token, googleAuth:true,
        isTrial: isPaidPlan,
        trialEnds: isPaidPlan ? new Date(Date.now()+7*24*60*60*1000) : null,
        msgCount:0, jobCount:0, createdAt:new Date()
      };
      await db.collection('users').insertOne(doc);
      user = doc;
    } else {
      if(user.status==='blocked') return res.json({ ok:false, msg:'Account suspended.' });
      const token = genToken(user._id.toString());
      await db.collection('users').updateOne({ _id:user._id }, { $set:{ token, lastLogin:new Date(), googleAuth:true } });
      user.token = token;
    }
    res.json({ ok:true, token:user.token, name:user.name, role:user.role||'user', plan:user.plan, business:user.business, email:user.email, isTrial:user.isTrial||false });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/me', async (req,res) => {
  try {
    const token = req.headers['x-token'];
    const user = await db.collection('users').findOne({ token });
    if(!user) return res.json({ ok:false, msg:'Invalid token' });

    // Check trial expiry on-the-fly
    let trialStatus = null;
    if(user.isTrial && user.trialEnds){
      const msLeft = new Date(user.trialEnds).getTime() - Date.now();
      if(msLeft <= 0){
        // Trial expired - downgrade to starter
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
      plan:user.plan, business:user.business, industry:user.industry,
      msgCount:user.msgCount||0, jobCount:user.jobCount||0, features,
      trial: trialStatus, trialExpired: user.trialExpired || false
    }});
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
async function adminAuth(req,res,next){
  const user = await db.collection('users').findOne({ token:req.headers['x-token'], role:'admin' });
  if(!user) return res.json({ ok:false, msg:'Unauthorized' });
  req.admin=user; next();
}
async function clientAuth(req,res,next){
  const user = await db.collection('users').findOne({ token:req.headers['x-token'] });
  if(!user) return res.json({ ok:false, msg:'Unauthorized' });
  if(user.status==='blocked') return res.json({ ok:false, msg:'Account suspended' });
  req.user=user; next();
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req,res) => {
  try {
    const user = await db.collection('users').findOne({ email:req.body.email, pass:req.body.pass, role:'admin' });
    if(!user) return res.json({ ok:false, msg:'Wrong email or password!' });
    const token = genToken('admin');
    await db.collection('users').updateOne({ _id:user._id }, { $set:{ token } });
    res.json({ ok:true, token });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/admin/users', adminAuth, async (req,res) => {
  const users = await db.collection('users').find({ role:{ $ne:'admin' } }).toArray();
  users.forEach(u => { u.id = u._id.toString(); });
  res.json({ ok:true, users });
});

app.post('/api/admin/users', adminAuth, async (req,res) => {
  try {
    const { name,email,pass,phone,plan,business,industry } = req.body;
    if(await db.collection('users').findOne({ email })) return res.json({ ok:false, msg:'Email exists' });
    const token = genToken(email);
    await db.collection('users').insertOne({
      name, email, pass, phone, business:business||name,
      industry:industry||'general', plan:plan||'starter',
      role:'user', status:'active', token, msgCount:0, jobCount:0, createdAt:new Date()
    });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    await db.collection('users').updateOne({ _id:new ObjectId(req.params.id) }, { $set:req.body });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req,res) => {
  try {
    await db.collection('users').deleteOne({ _id:new ObjectId(req.params.id) });
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
    // When admin manually sets plan, clear trial status (make it permanent)
    await db.collection('users').updateOne(
      { _id:new ObjectId(req.params.id) },
      { $set:{ plan:req.body.plan, isTrial:false, trialEnds:null, trialExpired:false } }
    );
    res.json({ ok:true });
  }
  catch(e){ res.json({ ok:false, msg:e.message }); }
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
    const { days=7 } = req.query;
    const since = new Date(Date.now() - days*24*60*60*1000);

    const logs = await db.collection('msg_logs').find({
      userId, createdAt:{ $gte:since }
    }).toArray();

    const total   = logs.length;
    const sent    = logs.filter(l => l.status==='sent').length;
    const failed  = logs.filter(l => l.status==='failed').length;
    const rate    = total ? Math.round((sent/total)*100) : 0;

    // Group by day
    const byDay = {};
    logs.forEach(l => {
      const day = new Date(l.createdAt).toLocaleDateString('en-IN');
      if(!byDay[day]) byDay[day] = { sent:0, failed:0 };
      byDay[day][l.status] = (byDay[day][l.status]||0)+1;
    });

    // Best hour to send
    const byHour = {};
    logs.filter(l => l.status==='sent').forEach(l => {
      const hr = new Date(l.createdAt).getHours();
      byHour[hr] = (byHour[hr]||0)+1;
    });
    const bestHour = Object.keys(byHour).sort((a,b) => byHour[b]-byHour[a])[0];

    // Scheduled stats
    const scheduledTotal  = await db.collection('scheduled_msgs').countDocuments({ userId });
    const scheduledPending= await db.collection('scheduled_msgs').countDocuments({ userId, status:'pending' });
    const scheduledSent   = await db.collection('scheduled_msgs').countDocuments({ userId, status:'sent' });

    res.json({ ok:true, stats:{ total, sent, failed, rate, byDay, bestHour, scheduledTotal, scheduledPending, scheduledSent, totalMsgCount:req.user.msgCount||0 } });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
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
    if(!contacts||!message||!scheduledAt) return res.json({ ok:false, msg:'contacts, message, scheduledAt required' });
    const list = JSON.parse(contacts);
    const task = {
      userId: req.user._id.toString(),
      title: title||'Scheduled Campaign',
      contacts: list,
      message,
      scheduledAt: new Date(scheduledAt),
      imageUrl: req.file ? req.file.path : null,
      status: 'pending',
      createdAt: new Date(),
      sentCount: 0
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
    const { customerName,customerPhone,serviceType,description,deviceModel,priority } = req.body;
    const jobId = await generateJobId(req.user._id.toString());
    const job = {
      jobId, clientId:req.user._id.toString(), clientName:req.user.business||req.user.name,
      customerName, customerPhone, serviceType:serviceType||'General',
      description, deviceModel, priority:priority||'normal',
      status:'pending',
      statusHistory:[{ status:'pending', time:new Date(), note:'Job created' }],
      cost:null, costApproved:null, technicianId:null, technicianName:null,
      images:[], createdAt:new Date(), updatedAt:new Date()
    };
    await db.collection('jobs').insertOne(job);
    await db.collection('users').updateOne({ _id:req.user._id }, { $inc:{ jobCount:1 } });
    res.json({ ok:true, job });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/jobs', clientAuth, async (req,res) => {
  try {
    const { status,search,page=1 } = req.query;
    const query = { clientId:req.user._id.toString() };
    if(status) query.status=status;
    if(search) query.$or=[{ jobId:{ $regex:search,$options:'i' } },{ customerName:{ $regex:search,$options:'i' } },{ customerPhone:{ $regex:search,$options:'i' } }];
    const total = await db.collection('jobs').countDocuments(query);
    const jobs  = await db.collection('jobs').find(query).sort({ createdAt:-1 }).skip((page-1)*20).limit(20).toArray();
    res.json({ ok:true, jobs, total });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.get('/api/jobs/:id', clientAuth, async (req,res) => {
  try {
    const job = await db.collection('jobs').findOne({ jobId:req.params.id, clientId:req.user._id.toString() });
    if(!job) return res.json({ ok:false, msg:'Job not found' });
    res.json({ ok:true, job });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/status', clientAuth, async (req,res) => {
  try {
    const { status,note } = req.body;
    await db.collection('jobs').updateOne(
      { jobId:req.params.id, clientId:req.user._id.toString() },
      { $set:{ status, updatedAt:new Date() }, $push:{ statusHistory:{ status, time:new Date(), note:note||'' } } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/cost', clientAuth, async (req,res) => {
  try {
    const { cost,costNote } = req.body;
    await db.collection('jobs').updateOne(
      { jobId:req.params.id, clientId:req.user._id.toString() },
      { $set:{ cost, costNote, costApproved:null, status:'cost_sent', updatedAt:new Date() }, $push:{ statusHistory:{ status:'cost_sent', time:new Date(), note:`Cost: ₹${cost}` } } }
    );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.put('/api/jobs/:id/technician', clientAuth, async (req,res) => {
  try {
    const tech = await db.collection('technicians').findOne({ _id:new ObjectId(req.body.technicianId) });
    if(!tech) return res.json({ ok:false, msg:'Technician not found' });
    await db.collection('jobs').updateOne({ jobId:req.params.id }, { $set:{ technicianId:req.body.technicianId, technicianName:tech.name, technicianPhone:tech.phone, updatedAt:new Date() } });
    res.json({ ok:true, technician:tech });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/jobs/:id/images', clientAuth, upload.array('images',5), async (req,res) => {
  try {
    const urls = req.files.map(f => '/uploads/jobs/'+f.filename);
    await db.collection('jobs').updateOne({ jobId:req.params.id }, { $push:{ images:{ $each:urls } } });
    res.json({ ok:true, urls });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── PUBLIC TRACKING ───────────────────────────────────────────────────────────
app.get('/api/track/:jobId', async (req,res) => {
  try {
    const job = await db.collection('jobs').findOne({ jobId:req.params.jobId });
    if(!job) return res.json({ ok:false, msg:'Job not found' });
    res.json({ ok:true, job:{ jobId:job.jobId, customerName:job.customerName, serviceType:job.serviceType, deviceModel:job.deviceModel, status:job.status, statusHistory:job.statusHistory, clientName:job.clientName, cost:job.costApproved?job.cost:job.status==='cost_sent'?job.cost:null, costNote:job.costNote, costApproved:job.costApproved, technicianName:job.technicianName, createdAt:job.createdAt, updatedAt:job.updatedAt } });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.post('/api/track/:jobId/approve', async (req,res) => {
  try {
    const { approved } = req.body;
    const status = approved?'approved':'cancelled';
    await db.collection('jobs').updateOne({ jobId:req.params.jobId }, { $set:{ costApproved:approved, status, updatedAt:new Date() }, $push:{ statusHistory:{ status, time:new Date(), note:approved?'Customer approved cost':'Customer rejected cost' } } });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── TECHNICIANS ───────────────────────────────────────────────────────────────
app.get('/api/technicians', clientAuth, async (req,res) => {
  const techs = await db.collection('technicians').find({ clientId:req.user._id.toString() }).toArray();
  res.json({ ok:true, technicians:techs });
});

app.post('/api/technicians', clientAuth, async (req,res) => {
  try {
    const { name,phone,skill,email } = req.body;
    await db.collection('technicians').insertOne({ name,phone,skill,email, clientId:req.user._id.toString(), jobsCompleted:0, status:'active', createdAt:new Date() });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

app.delete('/api/technicians/:id', clientAuth, async (req,res) => {
  try {
    await db.collection('technicians').deleteOne({ _id:new ObjectId(req.params.id), clientId:req.user._id.toString() });
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// ── CUSTOMERS ─────────────────────────────────────────────────────────────────
app.get('/api/customers', clientAuth, async (req,res) => {
  try {
    const { search } = req.query;
    const query = { clientId:req.user._id.toString() };
    if(search) query.$or=[{ customerName:{ $regex:search,$options:'i' } },{ customerPhone:{ $regex:search,$options:'i' } }];
    const customers = await db.collection('jobs').aggregate([
      { $match:query },
      { $group:{ _id:'$customerPhone', name:{ $last:'$customerName' }, phone:{ $last:'$customerPhone' }, totalJobs:{ $sum:1 }, lastJob:{ $max:'$createdAt' } } },
      { $sort:{ lastJob:-1 } }
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
    const userId = req.user._id.toString();
    const s = sessions[userId];
    if(!s||s.status!=='connected') return res.json({ ok:false, msg:'WhatsApp not connected' });
    const limit = PLAN_FEATURES[req.user.plan]?.msgLimit || 50;
    let list = JSON.parse(contacts);
    if(list.length>limit) return res.json({ ok:false, msg:`Plan limit: ${limit} messages/day` });
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
    // Save analytics logs
    if(logs.length) await db.collection('msg_logs').insertMany(logs);
    await db.collection('users').updateOne({ _id:req.user._id }, { $inc:{ msgCount:sent } });
    if(req.file) try{ fs.unlinkSync(req.file.path); }catch(e){}
    io.to('wa_'+userId).emit('done',{ total:list.length, sent });
  } catch(e){ res.json({ ok:false, msg:e.message }); }
});

// Send job WA notification
app.post('/api/wa/notify-job', clientAuth, async (req,res) => {
  try {
    const { jobId, type } = req.body;
    const userId = req.user._id.toString();
    const s = sessions[userId];
    if(!s||s.status!=='connected') return res.json({ ok:false, msg:'WhatsApp not connected' });
    const job = await db.collection('jobs').findOne({ jobId, clientId:userId });
    if(!job) return res.json({ ok:false, msg:'Job not found' });
    const trackUrl = `https://wa-marketing-saas-1.onrender.com/track/${jobId}`;
    const business = req.user.business||req.user.name;
    const msgs = {
     created:`Hi *${job.customerName}*! 👋\n\n*${business}* has received your service request.\n\n🔖 *Job ID:* ${jobId}\n🛠 *Service:* ${job.serviceType}\n📱 *Device:* ${job.deviceModel||'N/A'}\n📊 *Status:* Pending\n\n🔗 Track live:\n${trackUrl}\n\n— ${business}`,
      in_progress:`Hi *${job.customerName}*! 🔧\n\n*${business}* — Your work has started!\n\n🔖 *Job ID:* ${jobId}\n👨‍🔧 *Technician:* ${job.technicianName||'Assigned'}\n📊 *Status:* In Progress\n\n🔗 Track: ${trackUrl}\n\n— ${business}`,
      cost:`Hi *${job.customerName}*! 💰\n\n*${business}* — Repair estimate is ready.\n\n🔖 *Job ID:* ${jobId}\n💵 *Estimated Cost:* ₹${job.cost}\n📝 *Note:* ${job.costNote||''}\n\n✅ Approve/Reject:\n${trackUrl}\n\n— ${business}`,
      completed:`Hi *${job.customerName}*! ✅\n\n*${business}* — Your service is complete!\n\n🔖 *Job ID:* ${jobId}\n💵 *Amount:* ₹${job.cost||'0'}\n\nPlease collect your device.\n\n⭐ Feedback: ${trackUrl}\n\n— ${business}`,
      ready:`Hi *${job.customerName}*! 📦\n\n*${business}* — Your device is ready! Please come to collect it.\n\n🔖 Job ID: ${jobId}\n\n— ${business}`
    };
    const msg = msgs[type];
    if(!msg) return res.json({ ok:false, msg:'Invalid notification type' });
    let ph = String(job.customerPhone).replace(/\D/g,'');
    if(ph.length===10) ph='91'+ph;
    await s.sock.sendMessage(ph+'@s.whatsapp.net',{ text:msg });
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

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join_wa', (userId) => {
    socket.join('wa_'+userId);
    const s = sessions[userId];
    if(!s) return;
    if(s.status==='qr'&&s.qr) socket.emit('qr',{qr:s.qr});
    if(s.status==='connected') socket.emit('connected',{name:'User',number:''});
  });
  socket.on('start', async ({ token }) => {
    const user = await db.collection('users').findOne({ token });
    if(!user) return;
    const userId = user._id.toString();
    socket.join('wa_'+userId);
    if(sessions[userId]?.status==='connected'){ socket.emit('connected',{}); }
    else { await createSession(userId,socket); }
  });
});

// ── HEALTH + STATIC ───────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({ ok:true, sessions:Object.keys(sessions).length }));
app.get('/track/:jobId', (req,res) => res.sendFile(path.join(__dirname,'track.html')));
app.get('/shop',  (req,res) => res.sendFile(path.join(__dirname,'shop.html')));
app.get('/shop/', (req,res) => res.sendFile(path.join(__dirname,'shop.html')));
app.get('/invoice', (req,res) => res.sendFile(path.join(__dirname,'invoice.html')));
app.use('/uploads', express.static('uploads'));

// ── PAGES ─────────────────────────────────────────────────────────────────────
app.get('/',        (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',   (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/admin/',  (req,res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/client',  (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));
app.get('/client/', (req,res) => res.sendFile(path.join(__dirname,'public','client','index.html')));

const PORT = process.env.PORT || 8080;
server.listen(PORT, async () => { await connectDB(); console.log('WA Marketing Server on port', PORT); });
