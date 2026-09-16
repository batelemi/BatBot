const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const APP_URL = process.env.APP_URL || 'https://sdrive-1.onrender.com';
const WAVE_URL = process.env.WAVE_URL || 'https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=1000';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '2250152171974';
const WHATSAPP_GROUP_URL = process.env.WHATSAPP_GROUP_URL || 'https://chat.whatsapp.com/GikWdoQLZ8TFDHK2rTHH8T?s=cl&p=a&mlu=4&ilr=4';
const TELEGRAM_URL = process.env.TELEGRAM_URL || 'https://t.me/sdrive123';
const TELEGRAM_GROUP_URL = process.env.TELEGRAM_GROUP_URL || 'https://t.me/sdrive123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE-ME-TO-A-LONG-RANDOM-SECRET';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  secret: SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:7*24*60*60*1000}
}));

const db = new Database(path.join(__dirname,'sdrive.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 badge TEXT NOT NULL DEFAULT 'Membre S-Drive',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS analyses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 odds_type INTEGER NOT NULL CHECK(odds_type IN (2,10)),
 status TEXT NOT NULL DEFAULT 'payment_pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS password_resets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 admin_password_hash TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function normalizePhone(value){
  let p=String(value||'').trim().replace(/[^\d+]/g,'');
  if(!p) return '';
  if(p.startsWith('+225')) return p.substring(1);
  if(p.startsWith('225')) return p;
  if(p.startsWith('0')) return '225'+p.substring(1);
  return p;
}
function getCurrentUser(req){
  if(!req.session.userId) return null;
  return db.prepare('SELECT id,name,phone,badge,created_at FROM users WHERE id=?').get(req.session.userId);
}
function requireAuth(req,res,next){
  if(!req.session.userId) return res.status(401).json({success:false,error:'Connexion requise.'});
  next();
}
function whatsappLink(message){
  const number=String(WHATSAPP_NUMBER).replace(/[^\d]/g,'');
  if(!number) return null;
  return 'https://wa.me/'+number+'?text='+encodeURIComponent(message);
}
function isAdmin(req){
  return Boolean(req.session.admin);
}
function requireAdmin(req,res,next){
  if(!isAdmin(req)) return res.status(403).json({success:false,error:'Accès administrateur requis.'});
  next();
}
function safeUser(user){
  return user ? {id:user.id,name:user.name,phone:user.phone,badge:user.badge,created_at:user.created_at} : null;
}

app.get('/',(req,res)=>{
  const user=getCurrentUser(req);
  const loggedIn=Boolean(user);
  res.send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#071A2D"><title>S-Drive — Analyse des matchs</title>
<style>
:root{--navy:#071A2D;--navy2:#0B223D;--card:#102B4C;--line:#23486B;--blue:#00BFFF;--green:#21C55D;--red:#DC2626;--white:#FFF;--muted:#AFC1D4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Arial,Helvetica,sans-serif;color:var(--white);background:radial-gradient(circle at top,#12385C 0%,var(--navy) 58%)}
.container{width:min(calc(100% - 28px),520px);margin:auto;padding:18px 0 35px}.center{text-align:center}
.logo{width:100px;height:100px;margin:15px auto 8px;display:flex;justify-content:center;align-items:center;border-radius:50%;font-size:64px;background:rgba(0,191,255,.10);border:1px solid rgba(0,191,255,.25)}
h1{margin:8px 0 5px;font-size:32px}h2{margin:0 0 16px;font-size:21px}.muted{color:var(--muted);line-height:1.55}
.card{background:rgba(16,43,76,.96);border:1px solid var(--line);border-radius:20px;padding:20px;margin:15px 0;box-shadow:0 8px 25px rgba(0,0,0,.18)}
input{width:100%;padding:15px;margin:7px 0;border-radius:12px;border:1px solid #3C5F7E;background:var(--navy2);color:var(--white);font-size:16px;outline:none}input:focus{border-color:var(--blue)}
.password-wrap{position:relative}.password-wrap input{padding-right:50px}.eye{position:absolute;right:8px;top:7px;height:46px;width:42px;border:0;background:transparent;color:white;font-size:20px;cursor:pointer}
.btn{width:100%;min-height:52px;padding:14px;border-radius:14px;font-weight:800;font-size:15px;border:0;margin:8px 0;cursor:pointer;text-decoration:none;display:flex;justify-content:center;align-items:center;text-align:center}.btn:active{transform:scale(.98)}
.primary{background:var(--blue);color:#001B2D}.green{background:var(--green);color:#FFF}.secondary{background:#193A5C;color:#FFF;border:1px solid #315D82}.danger{background:#7F1D1D;color:#FFF}
.choice{border:1px solid #315D82;background:#0B223D;padding:17px;border-radius:15px;margin:9px 0;cursor:pointer}.choice strong{display:block;font-size:18px;margin-bottom:6px}.choice small{color:var(--muted);line-height:1.4}.choice.selected{border-color:var(--blue);background:#123B60;transform:scale(1.01)}
.price{font-size:28px;font-weight:900;text-align:center;margin:17px 0}.notice{padding:14px;border-left:3px solid var(--blue);background:#0C2745;border-radius:8px;line-height:1.55;margin:10px 0}
.status{margin-top:12px;color:var(--muted);text-align:center;min-height:24px;line-height:1.4}.status.success{color:#6EE7A0}.status.error{color:#FF8A8A}
.user-box{background:rgba(7,26,45,.65);border:1px solid var(--line);padding:14px;border-radius:14px;margin-bottom:15px;text-align:center}.share-box{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hidden{display:none!important}
.badge{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border-radius:999px;background:#123B60;border:1px solid var(--blue);font-size:12px;font-weight:800}
footer{text-align:center;color:var(--muted);font-size:12px;margin-top:25px}@media(max-width:360px){.container{width:calc(100% - 20px)}h1{font-size:28px}.card{padding:16px}}
</style></head><body><main class="container">

<section id="auth" class="${loggedIn?'hidden':''}">
<div class="center"><div class="logo">⚽</div><h1>S-Drive</h1><p class="muted">Analyse professionnelle de vos matchs</p></div>
<div class="card"><h2>Connexion</h2>
<input id="loginPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Numéro de téléphone">
<div class="password-wrap"><input id="loginPassword" type="password" autocomplete="current-password" placeholder="Mot de passe"><button class="eye" type="button" onclick="togglePassword('loginPassword',this)">👁</button></div>
<button id="loginButton" class="btn primary" type="button" onclick="login()">Se connecter</button>
<button class="btn secondary" type="button" onclick="forgotPassword()">🔑 Mot de passe oublié ?</button><div id="loginStatus" class="status"></div></div>

<div class="card"><h2>Créer un compte</h2>
<input id="registerName" type="text" autocomplete="name" placeholder="Nom d'utilisateur">
<input id="registerPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Numéro de téléphone WhatsApp">
<div class="password-wrap"><input id="registerPassword" type="password" autocomplete="new-password" placeholder="Mot de passe — 6 caractères minimum"><button class="eye" type="button" onclick="togglePassword('registerPassword',this)">👁</button></div>
<div class="password-wrap"><input id="registerPassword2" type="password" autocomplete="new-password" placeholder="Confirmer le mot de passe"><button class="eye" type="button" onclick="togglePassword('registerPassword2',this)">👁</button></div>
<button id="registerButton" class="btn primary" type="button" onclick="register()">Créer mon compte</button><div id="registerStatus" class="status"></div></div>
</section>

<section id="dashboard" class="${loggedIn?'':'hidden'}">
<div class="center"><div class="logo">⚽</div><h1>S-Drive</h1><p class="muted">Bienvenue ${user?escapeHtml(user.name):''}</p>${user?`<span class="badge">🏅 ${escapeHtml(user.badge)}</span>`:''}</div>
<div class="user-box">👤 Compte connecté<br><span class="muted">${user?escapeHtml(user.phone):''}</span></div>

<div class="card"><h2>Analyse des matchs</h2><div class="notice">Choisissez le type d'analyse que vous souhaitez.</div>
<div id="choice2" class="choice selected" onclick="selectOdds(2)"><strong>Cote 2</strong><small>Analyse rapide — environ 2 à 3 minutes</small></div>
<div id="choice10" class="choice" onclick="selectOdds(10)"><strong>Cote 10</strong><small>Analyse complète — environ 7 à 8 minutes</small></div>
<div class="price">1 000 F</div><p class="muted center">Paiement unique pour l'analyse.</p>
<a class="btn green" href="${WAVE_URL}" target="_blank" rel="noopener noreferrer">💳 Payer 1 000 F avec Wave</a>
<button class="btn primary" type="button" onclick="sendMatchScreenshot()">📸 Envoyer la capture</button><div id="analysisStatus" class="status"></div></div>

<div class="card"><h2>📲 Envoyer sur WhatsApp ou Telegram</h2><a class="btn primary" href="${whatsappLink('Bonjour S-Drive 👋 Je souhaite envoyer ma capture de matchs.')||'#'}" target="_blank" rel="noopener noreferrer">🟢 Ouvrir WhatsApp</a>
<a class="btn secondary" href="${TELEGRAM_URL}" target="_blank" rel="noopener noreferrer">🔵 Ouvrir Telegram</a></div>

<div class="card"><h2>👥 Rejoindre la communauté</h2><p class="muted">Rejoignez nos communautés pour recevoir les informations et échanger avec les autres membres.</p>
<a class="btn primary" href="${WHATSAPP_GROUP_URL}" target="_blank" rel="noopener noreferrer">🟢 Groupe WhatsApp</a>
<a class="btn secondary" href="${TELEGRAM_GROUP_URL}" target="_blank" rel="noopener noreferrer">🔵 Groupe Telegram</a></div>

<div class="card"><h2>Partager S-Drive</h2><p class="muted">Invitez vos amis à découvrir S-Drive.</p><div class="share-box"><button class="btn secondary" onclick="copyAppLink()">📋 Copier le lien</button><button class="btn secondary" onclick="shareApp()">📤 Partager</button></div><div id="shareStatus" class="status"></div></div>

<div class="card"><h2>Conditions d'utilisation</h2><div class="notice"><strong>Cote 2</strong><br><br>Après paiement et réception de votre capture, S-Drive analyse vos matchs de cote 2.<br><br>Délai indicatif : <strong>2 à 3 minutes</strong>.<br><br>Si le coupon de cote 2 analysé et envoyé par S-Drive est validé après votre pari, aucun montant supplémentaire ne sera demandé.<br><br>Si le coupon de cote 2 n'est pas validé, vous pouvez réclamer un remboursement de <strong>500 F</strong>.</div>
<div class="notice"><strong>Cote 10</strong><br><br>Délai indicatif : <strong>7 à 8 minutes</strong>.<br><br>Pour une analyse de cote 10, aucun remboursement n'est prévu après le gain ou la perte du pari.</div><p class="muted">Le paiement de l'analyse est de <strong>1 000 F</strong>.</p></div>
<button class="btn danger" onclick="logout()">Se déconnecter</button></section>

<section id="admin" class="hidden"><div class="center"><div class="logo">🛠️</div><h1>Administration</h1><p class="muted">Gestion S-Drive</p></div><div class="card"><h2>Clients inscrits</h2><div id="adminStats" class="notice">Chargement...</div><div id="usersList"></div></div><div class="card"><h2>Demandes de mot de passe</h2><div id="resetList">Chargement...</div></div><button class="btn danger" onclick="adminLogout()">Quitter l'administration</button></section>

<footer>S-Drive — Analyse des matchs</footer></main>

<script>
let selectedOdds=2;
function escapeHtml(value){return String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
function showStatus(id,msg,type=''){const e=document.getElementById(id);if(e){e.textContent=msg;e.className='status '+type}}
function togglePassword(id,btn){const e=document.getElementById(id);e.type=e.type==='password'?'text':'password';btn.textContent=e.type==='password'?'👁':'🙈'}
function setLoading(id,loading,text){const b=document.getElementById(id);if(!b)return;b.disabled=loading;b.textContent=loading?'Patientez...':text}
function selectOdds(type){if(type!==2&&type!==10)return;selectedOdds=type;document.getElementById('choice2').classList.toggle('selected',type===2);document.getElementById('choice10').classList.toggle('selected',type===10)}
async function register(){
 const name=document.getElementById('registerName').value.trim(),phone=document.getElementById('registerPhone').value.trim(),password=document.getElementById('registerPassword').value,password2=document.getElementById('registerPassword2').value;
 showStatus('registerStatus','');if(!name)return showStatus('registerStatus','Veuillez entrer votre nom d’utilisateur.','error');if(!phone)return showStatus('registerStatus','Veuillez entrer votre numéro WhatsApp.','error');if(password.length<6)return showStatus('registerStatus','Le mot de passe doit contenir au moins 6 caractères.','error');if(password!==password2)return showStatus('registerStatus','Les deux mots de passe ne correspondent pas.','error');
 setLoading('registerButton',true,'Créer mon compte');try{const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({name,phone,password})});const d=await r.json().catch(()=>({}));if(!r.ok)return showStatus('registerStatus',d.error||'Erreur lors de l’inscription.','error');showStatus('registerStatus','Compte créé avec succès 🏅','success');setTimeout(()=>location.reload(),500)}catch(e){showStatus('registerStatus','Impossible de contacter le serveur.','error')}setLoading('registerButton',false,'Créer mon compte')
}
async function login(){
 const phone=document.getElementById('loginPhone').value.trim(),password=document.getElementById('loginPassword').value;showStatus('loginStatus','');if(!phone||!password)return showStatus('loginStatus','Veuillez remplir tous les champs.','error');setLoading('loginButton',true,'Se connecter');
 try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({phone,password})});const d=await r.json().catch(()=>({}));if(!r.ok)return showStatus('loginStatus',d.error||'Numéro ou mot de passe incorrect.','error');location.reload()}catch(e){showStatus('loginStatus','Impossible de contacter le serveur.','error')}setLoading('loginButton',false,'Se connecter')
}
async function forgotPassword(){
 const phone=prompt('Entrez votre numéro WhatsApp :');if(!phone)return;try{const r=await fetch('/api/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});const d=await r.json().catch(()=>({}));alert(d.message||d.error||'Demande envoyée.')}catch(e){alert('Impossible de contacter le serveur.')}
}
async function sendMatchScreenshot(){
 const s=document.getElementById('analysisStatus');s.textContent='Préparation de votre demande...';try{const r=await fetch('/api/create-analysis',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({odds_type:selectedOdds})});const d=await r.json().catch(()=>({}));if(!r.ok){s.textContent=d.error||'Impossible de créer la demande.';s.className='status error';return}s.textContent='Demande créée. Envoyez votre capture sur WhatsApp ou Telegram.';s.className='status success';if(d.whatsapp_url)window.open(d.whatsapp_url,'_blank')}catch(e){s.textContent='Erreur de connexion au serveur.';s.className='status error'}
}
async function copyAppLink(){try{await navigator.clipboard.writeText(window.location.origin);showStatus('shareStatus','Lien copié avec succès.','success')}catch(e){showStatus('shareStatus','Impossible de copier le lien.','error')}}
async function shareApp(){const d={title:'S-Drive',text:'Découvrez S-Drive — Analyse professionnelle de vos matchs.',url:window.location.origin};try{if(navigator.share)await navigator.share(d);else await copyAppLink()}catch(e){}}
async function logout(){await fetch('/api/logout',{method:'POST'}).catch(()=>{});location.reload()}
async function adminLogout(){await fetch('/api/admin/logout',{method:'POST'}).catch(()=>{});location.reload()}
async function adminLogin(){const phone=document.getElementById('adminPhone').value.trim(),password=document.getElementById('adminPassword').value;if(!phone||!password)return showStatus('adminLoginStatus','Remplissez les champs.','error');try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,password})});const d=await r.json().catch(()=>({}));if(!r.ok)return showStatus('adminLoginStatus',d.error||'Accès refusé.','error');loadAdmin()}catch(e){showStatus('adminLoginStatus','Erreur serveur.','error')}}
async function loadAdmin(){document.getElementById('auth').classList.add('hidden');document.getElementById('dashboard').classList.add('hidden');document.getElementById('admin').classList.remove('hidden');const r=await fetch('/api/admin/users');const d=await r.json();document.getElementById('adminStats').textContent='Nombre total de clients : '+d.users.length;document.getElementById('usersList').innerHTML=d.users.map(u=>'<div class="notice"><strong>'+escapeHtml(u.name)+'</strong><br>'+escapeHtml(u.phone)+'<br><span class="badge">🏅 '+escapeHtml(u.badge)+'</span></div>').join('')||'<p class="muted">Aucun client.</p>';const rr=await fetch('/api/admin/reset-requests');const rd=await rr.json();document.getElementById('resetList').innerHTML=rd.requests.map(x=>'<div class="notice"><strong>'+escapeHtml(x.name)+'</strong><br>'+escapeHtml(x.phone)+'<br><button class="btn green" onclick="resolveReset('+x.id+')">Envoyer une réinitialisation</button></div>').join('')||'<p class="muted">Aucune demande en attente.</p>'}
async function resolveReset(id){const r=await fetch('/api/admin/reset/'+id,{method:'POST'});const d=await r.json();alert(d.message||d.error);loadAdmin()}
async function openAdmin(){document.getElementById('auth').classList.add('hidden');document.getElementById('dashboard').classList.add('hidden');document.getElementById('admin').classList.remove('hidden');document.getElementById('admin').innerHTML='<div class="card"><h2>Connexion administrateur</h2><input id="adminPhone" type="tel" placeholder="Téléphone administrateur"><input id="adminPassword" type="password" placeholder="Mot de passe administrateur"><button class="btn primary" onclick="adminLogin()">Accéder</button><div id="adminLoginStatus" class="status"></div></div>'}
document.addEventListener('DOMContentLoaded',async()=>{const r=await fetch('/api/me').catch(()=>null);if(r&&r.ok){const d=await r.json();if(d.user){document.getElementById('auth').classList.add('hidden');document.getElementById('dashboard').classList.remove('hidden')}}});
</script></body></html>`);
});

app.post('/api/register',async(req,res)=>{
 try{
  const name=String(req.body.name||'').trim(),phone=normalizePhone(req.body.phone),password=String(req.body.password||'');
  if(!name)return res.status(400).json({success:false,error:'Veuillez entrer votre nom d’utilisateur.'});
  if(!phone)return res.status(400).json({success:false,error:'Veuillez entrer votre numéro WhatsApp.'});
  if(password.length<6)return res.status(400).json({success:false,error:'Le mot de passe doit contenir au moins 6 caractères.'});
  if(db.prepare('SELECT id FROM users WHERE phone=?').get(phone))return res.status(409).json({success:false,error:'Ce numéro est déjà enregistré. Connectez-vous.'});
  const hash=await bcrypt.hash(password,10);
  const result=db.prepare('INSERT INTO users(name,phone,password_hash,badge) VALUES(?,?,?,?)').run(name,phone,hash,'Membre S-Drive');
  req.session.userId=Number(result.lastInsertRowid);
  res.status(201).json({success:true,message:'Compte créé avec succès.',user:{id:result.lastInsertRowid,name,phone,badge:'Membre S-Drive'}});
 }catch(e){console.error(e);res.status(500).json({success:false,error:'Erreur serveur lors de la création du compte.'})}
});
app.post('/api/login',async(req,res)=>{
 try{const phone=normalizePhone(req.body.phone),password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE phone=?').get(phone);if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({success:false,error:'Numéro ou mot de passe incorrect.'});req.session.userId=u.id;res.json({success:true,user:safeUser(u)})}catch(e){res.status(500).json({success:false,error:'Erreur serveur.'})}
});
app.post('/api/forgot-password',(req,res)=>{
 const phone=normalizePhone(req.body.phone);const u=db.prepare('SELECT id FROM users WHERE phone=?').get(phone);if(!u)return res.json({success:true,message:'Si ce numéro existe, une demande sera transmise à l’administrateur.'});db.prepare("INSERT INTO password_resets(user_id,status) VALUES(?,'pending')").run(u.id);res.json({success:true,message:'Demande envoyée à l’administrateur. Vous recevrez les instructions de réinitialisation.'});
});
app.get('/api/me',(req,res)=>{const u=getCurrentUser(req);if(!u)return res.status(401).json({success:false,error:'Non connecté.'});res.json({success:true,user:safeUser(u)})});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.post('/api/create-analysis',requireAuth,(req,res)=>{
 const odds=Number(req.body.odds_type);if(odds!==2&&odds!==10)return res.status(400).json({success:false,error:'Type d’analyse incorrect.'});const u=getCurrentUser(req);const result=db.prepare("INSERT INTO analyses(user_id,odds_type,status) VALUES(?,?, 'payment_pending')").run(u.id,odds);const msg=['Bonjour S-Drive 👋','Je viens de créer une demande d’analyse.','Client : '+u.name,'Téléphone : '+u.phone,'Type : Cote '+odds,'Référence : SD-'+result.lastInsertRowid,'Je vais envoyer la capture de mes matchs.'].join('\n');res.status(201).json({success:true,analysis_id:result.lastInsertRowid,whatsapp_url:whatsappLink(msg)});
});
app.post('/api/admin/login',(req,res)=>{const p=normalizePhone(req.body.phone),pass=String(req.body.password||'');if(!ADMIN_PHONE||!ADMIN_PASSWORD)return res.status(503).json({success:false,error:'Configurez ADMIN_PHONE et ADMIN_PASSWORD dans Render.'});if(p!==normalizePhone(ADMIN_PHONE)||pass!==ADMIN_PASSWORD)return res.status(401).json({success:false,error:'Identifiants administrateur incorrects.'});req.session.admin=true;res.json({success:true})});
app.post('/api/admin/logout',(req,res)=>{req.session.admin=false;res.json({success:true})});
app.get('/api/admin/users',requireAdmin,(req,res)=>res.json({success:true,users:db.prepare('SELECT id,name,phone,badge,created_at FROM users ORDER BY id DESC').all()}));
app.get('/api/admin/reset-requests',requireAdmin,(req,res)=>res.json({success:true,requests:db.prepare("SELECT pr.id,u.name,u.phone FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.status='pending' ORDER BY pr.id DESC").all()}));
app.post('/api/admin/reset/:id',requireAdmin,(req,res)=>{
 const x=db.prepare("SELECT pr.id,u.name,u.phone FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.id=? AND pr.status='pending'").get(req.params.id);
 if(!x)return res.status(404).json({success:false,error:'Demande introuvable.'});
 const temporary='SD-'+Math.random().toString(36).slice(2,8).toUpperCase();
 const hash=bcrypt.hashSync(temporary,10);
 db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash,x.user_id||0);
 db.prepare("UPDATE password_resets SET status='resolved',admin_password_hash=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(hash,x.id);
 const url=whatsappLink('Bonjour '+x.name+', votre mot de passe temporaire S-Drive est : '+temporary+'. Connectez-vous puis modifiez-le si vous le souhaitez.');
 res.json({success:true,message:'Réinitialisation créée. '+(url?'Le bouton WhatsApp peut être utilisé pour transmettre le nouveau mot de passe.':'Configurez WHATSAPP_NUMBER dans Render.')});
});
app.get('/api/health',(req,res)=>res.json({success:true,message:'S-Drive fonctionne correctement.',time:new Date().toISOString()}));
app.use((req,res)=>req.path.startsWith('/api/')?res.status(404).json({success:false,error:'Route API introuvable.'}):res.status(404).send('Page introuvable.'));
app.listen(PORT,'0.0.0.0',()=>console.log('S-Drive démarré sur le port '+PORT));
