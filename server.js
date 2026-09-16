const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '2250152171974';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEFAULTS = {
  whatsapp_number:'2250152171974',
  telegram_contact:'https://t.me/sdrive12',
  whatsapp_group:'https://chat.whatsapp.com/GikWdoQLZ8TFDHK2rTHH8T?s=cl&p=a&mlu=4&ilr=4',
  telegram_group:'https://t.me/sdrive123',
  tiktok:'https://www.tiktok.com/@batelemi92',
  facebook:'https://www.facebook.com/share/1KDERc7ZAP/',
  instagram:'https://www.instagram.com/wonda_boss_officil/',
  wave_day:'https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=500',
  wave_premium:'https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=1000',
  payment_number:'0152171974',
  payment_label:'Orange Money / Moov Money / MTN Money',
  bookmaker1_name:'1win', bookmaker1_url:'https://one-vv3942.com/?p=gc9k&sub1=DM07',
  bookmaker2_name:'Paripesa', bookmaker2_url:'https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651',
  bookmaker3_name:'Afropari', bookmaker3_url:'https://apaff.top/L?tag=d_3763651m_70055c_&site=70055&ad=70055'
};

app.set('trust proxy',1);
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*24*60*60*1000}}));

const db = new Database(path.join(__dirname,'sdrive.db'));
db.pragma('foreign_keys = ON');

function tableColumns(table){return db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name)}
function migrateUsers(){
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if(!exists){
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,phone TEXT,password_hash TEXT NOT NULL,badge TEXT NOT NULL DEFAULT 'Membre S-Drive',is_premium INTEGER NOT NULL DEFAULT 0,premium_started_at TEXT,premium_expires_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);return;
  }
  const cols=tableColumns('users');
  if(cols.includes('username') && cols.includes('is_premium')) return;
  db.pragma('foreign_keys = OFF');
  db.exec('ALTER TABLE users RENAME TO users_legacy');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,phone TEXT,password_hash TEXT NOT NULL,badge TEXT NOT NULL DEFAULT 'Membre S-Drive',is_premium INTEGER NOT NULL DEFAULT 0,premium_started_at TEXT,premium_expires_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const legacyCols=tableColumns('users_legacy');
  const rows=db.prepare('SELECT * FROM users_legacy').all();
  for(const r of rows){
    const base=String(r.name||r.username||('user'+r.id)).trim() || ('user'+r.id);
    let username=base.replace(/\s+/g,'_').slice(0,30) || ('user'+r.id);
    let n=1; while(db.prepare('SELECT id FROM users WHERE username=?').get(username)){username=(base.slice(0,25)+'_'+n++).slice(0,30)}
    db.prepare('INSERT INTO users(id,username,name,phone,password_hash,badge,created_at) VALUES(?,?,?,?,?,?,?)').run(r.id,username,base,r.phone||'',r.password_hash,r.badge||'Membre S-Drive',r.created_at||new Date().toISOString());
  }
  db.exec('DROP TABLE users_legacy');
  db.pragma('foreign_keys = ON');
}

migrateUsers();
db.exec(`
CREATE TABLE IF NOT EXISTS password_resets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',admin_password_hash TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,resolved_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS daily_matches(id INTEGER PRIMARY KEY AUTOINCREMENT,match_name TEXT NOT NULL,home_probability REAL NOT NULL,draw_probability REAL NOT NULL,away_probability REAL NOT NULL,recommended_pick TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`);
for(const [k,v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)').run(k,v);

function setting(key){return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? DEFAULTS[key] ?? ''}
function allSettings(){const out={...DEFAULTS};for(const r of db.prepare('SELECT key,value FROM app_settings').all())out[r.key]=r.value;return out}
function normalizePhone(v){let p=String(v||'').replace(/[^\d+]/g,'').trim();if(p.startsWith('+225'))p=p.slice(1);if(p.startsWith('0'))p='225'+p.slice(1);return p}
function whatsappLink(message){const n=normalizePhone(setting('whatsapp_number'));return n?'https://wa.me/'+n+'?text='+encodeURIComponent(message):'#'}
function currentUser(req){if(!req.session.userId)return null;return db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId)}
function safeUser(u){if(!u)return null;const premium=Number(u.is_premium)===1 && (!u.premium_expires_at || new Date(u.premium_expires_at)>new Date());return {id:u.id,username:u.username,name:u.name,badge:premium?'Premium':'Membre S-Drive',is_premium:premium,premium_started_at:u.premium_started_at,premium_expires_at:u.premium_expires_at,created_at:u.created_at}}
function requireAuth(req,res,next){if(!req.session.userId)return res.status(401).json({error:'Connexion requise.'});next()}
function requireAdmin(req,res,next){if(!req.session.admin)return res.status(403).json({error:'Accès administrateur requis.'});next()}
function sendSession(res){res.json({success:true})}

app.use(express.static(path.join(__dirname,'public'),{index:'index.html',maxAge:0}));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.post('/api/register',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase();const password=String(req.body.password||'');if(username.length<3)return res.status(400).json({error:'Le nom d’utilisateur doit contenir au moins 3 caractères.'});if(password.length<6)return res.status(400).json({error:'Le mot de passe doit contenir au moins 6 caractères.'});if(!/^[a-z0-9_.-]+$/.test(username))return res.status(400).json({error:'Utilisez seulement lettres, chiffres, point, tiret ou underscore.'});if(db.prepare('SELECT id FROM users WHERE username=?').get(username))return res.status(409).json({error:'Ce nom d’utilisateur existe déjà.'});const hash=await bcrypt.hash(password,12);const r=db.prepare('INSERT INTO users(username,name,phone,password_hash,badge) VALUES(?,?,?,?,?)').run(username,username,'',hash,'Membre S-Drive');req.session.userId=Number(r.lastInsertRowid);req.session.save(()=>res.status(201).json({success:true,message:'Compte créé avec succès.',user:safeUser(currentUser(req))}));}catch(e){console.error(e);res.status(500).json({error:'Erreur serveur lors de la création du compte.'})}});

app.post('/api/login',async(req,res)=>{try{const username=String(req.body.username||'').trim().toLowerCase();const password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Nom d’utilisateur ou mot de passe incorrect.'});req.session.userId=u.id;req.session.save(()=>res.json({success:true,user:safeUser(u)}));}catch(e){console.error(e);res.status(500).json({error:'Erreur serveur.'})}});
app.get('/api/me',(req,res)=>{const u=currentUser(req);if(!u)return res.status(401).json({error:'Non connecté.'});res.json({success:true,user:safeUser(u)})});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.post('/api/password-reset',(req,res)=>{const username=String(req.body.username||'').trim().toLowerCase();const u=db.prepare('SELECT id FROM users WHERE username=?').get(username);if(u)db.prepare("INSERT INTO password_resets(user_id,status) VALUES(?,'pending')").run(u.id);res.json({success:true,message:'Demande envoyée à l’administrateur.',whatsapp_url:whatsappLink(`Bonjour S-Drive 👋\n\nJe souhaite réinitialiser mon mot de passe.\n\nNom d'utilisateur : ${username}`)})});
app.get('/api/settings',requireAuth,(req,res)=>res.json({success:true,settings:allSettings()}));
app.get('/api/daily-matches',requireAuth,(req,res)=>res.json(db.prepare('SELECT * FROM daily_matches ORDER BY id DESC').all()));

app.post('/api/admin/login',(req,res)=>{const phone=normalizePhone(req.body.phone),password=String(req.body.password||'');if(!ADMIN_PASSWORD)return res.status(503).json({error:'ADMIN_PASSWORD n’est pas configuré dans Render.'});if(phone!==normalizePhone(ADMIN_PHONE)||password!==ADMIN_PASSWORD)return res.status(401).json({error:'Identifiants administrateur incorrects.'});req.session.admin=true;req.session.save(()=>res.json({success:true}))});
app.post('/api/admin/logout',(req,res)=>{req.session.admin=false;req.session.save(()=>res.json({success:true}))});
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({success:true}));
app.get('/api/admin/users',requireAdmin,(req,res)=>{const q=String(req.query.q||'').trim().toLowerCase();let sql='SELECT id,username,name,phone,badge,is_premium,premium_started_at,premium_expires_at,created_at FROM users';const params=[];if(q){sql+=' WHERE lower(username) LIKE ? OR lower(name) LIKE ?';params.push('%'+q+'%','%'+q+'%')}sql+=' ORDER BY id DESC';const users=db.prepare(sql).all(...params).map(u=>({...u,is_premium:Number(u.is_premium)===1 && (!u.premium_expires_at||new Date(u.premium_expires_at)>new Date()),badge:(Number(u.is_premium)===1&&(!u.premium_expires_at||new Date(u.premium_expires_at)>new Date()))?'Premium':'Membre S-Drive'}));res.json({success:true,users})});
app.get('/api/admin/reset-requests',requireAdmin,(req,res)=>res.json({success:true,requests:db.prepare("SELECT pr.id,u.username,pr.created_at FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.status='pending' ORDER BY pr.id DESC").all()}));
app.post('/api/admin/reset-requests/:id/resolve',requireAdmin,async(req,res)=>{const x=db.prepare("SELECT pr.id,pr.user_id,u.username FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.id=? AND pr.status='pending'").get(req.params.id);if(!x)return res.status(404).json({error:'Demande introuvable.'});const temp='SD-'+crypto.randomBytes(4).toString('hex').toUpperCase();const hash=await bcrypt.hash(temp,12);db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,x.user_id);db.prepare("UPDATE password_resets SET status='resolved',admin_password_hash=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(hash,x.id);res.json({success:true,message:'Nouveau mot de passe généré pour '+x.username+'.',new_password:temp})});

app.post('/api/admin/users/:id/premium',requireAdmin,(req,res)=>{const id=Number(req.params.id);const days=Math.max(1,Number(req.body.days||7));const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!u)return res.status(404).json({error:'Utilisateur introuvable.'});const start=new Date();const end=new Date(start.getTime()+days*86400000);db.prepare("UPDATE users SET is_premium=1,badge='Premium',premium_started_at=?,premium_expires_at=? WHERE id=?").run(start.toISOString(),end.toISOString(),id);res.json({success:true,message:'Badge Premium activé pour '+days+' jours.',user:safeUser(currentUser({session:{userId:id}}))})});
app.post('/api/admin/users/:id/premium/deactivate',requireAdmin,(req,res)=>{const id=Number(req.params.id);db.prepare("UPDATE users SET is_premium=0,badge='Membre S-Drive',premium_started_at=NULL,premium_expires_at=NULL WHERE id=?").run(id);res.json({success:true,message:'Abonnement Premium désactivé.'})});
app.delete('/api/admin/users/:id',requireAdmin,(req,res)=>{db.prepare('DELETE FROM users WHERE id=?').run(Number(req.params.id));res.json({success:true,message:'Utilisateur supprimé.'})});

app.get('/api/admin/settings',requireAdmin,(req,res)=>res.json({success:true,settings:allSettings()}));
app.post('/api/admin/settings',requireAdmin,(req,res)=>{const allowed=new Set(Object.keys(DEFAULTS));const incoming=req.body||{};const tx=db.transaction(()=>{for(const [k,v] of Object.entries(incoming)){if(allowed.has(k))db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v||''))}});tx();res.json({success:true,settings:allSettings()})});
app.post('/api/admin/daily-matches',requireAdmin,(req,res)=>{const name=String(req.body.match_name||'').trim();const h=Number(req.body.home_probability),d=Number(req.body.draw_probability),a=Number(req.body.away_probability);const pick=String(req.body.recommended_pick||'').trim();if(!name||![h,d,a].every(Number.isFinite)||Math.abs(h+d+a-100)>0.01||[h,d,a].some(x=>x<0||x>100))return res.status(400).json({error:'Données de probabilités invalides. Le total doit être 100 %.'});const r=db.prepare('INSERT INTO daily_matches(match_name,home_probability,draw_probability,away_probability,recommended_pick) VALUES(?,?,?,?,?)').run(name,h,d,a,pick);res.json({success:true,id:r.lastInsertRowid,message:'Match ajouté.'})});
app.get('/api/admin/daily-matches',requireAdmin,(req,res)=>res.json(db.prepare('SELECT * FROM daily_matches ORDER BY id DESC').all()));
app.delete('/api/admin/daily-matches/:id',requireAdmin,(req,res)=>{db.prepare('DELETE FROM daily_matches WHERE id=?').run(Number(req.params.id));res.json({success:true,message:'Match supprimé.'})});

app.get('/api/health',(req,res)=>res.json({success:true,message:'S-Drive fonctionne.',time:new Date().toISOString()}));
app.use((req,res)=>req.path.startsWith('/api/')?res.status(404).json({error:'Route API introuvable.'}):res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log('S-Drive démarré sur le port '+PORT));
