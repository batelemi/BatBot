const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const PORT = process.env.PORT || 3000;
const DB = new Database(path.join(__dirname, "sdrive.db"));

app.use(express.json({limit:"8mb"}));
app.use(express.urlencoded({extended:true,limit:"8mb"}));
DB.pragma("journal_mode = WAL");
DB.pragma("foreign_keys = ON");

DB.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 phone TEXT DEFAULT '',
 password_hash TEXT NOT NULL,
 premium_until TEXT,
 premium_started_at TEXT,
 premium_disabled_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS daily_matches(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 match_name TEXT NOT NULL,
 home_probability REAL NOT NULL,
 draw_probability REAL NOT NULL,
 away_probability REAL NOT NULL,
 recommended_pick TEXT NOT NULL,
 odds REAL,
 match_date TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_resets(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS analysis_requests(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER,
 type TEXT NOT NULL,
 content TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function addColumn(table, column, definition){
  try{ DB.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }catch(e){ if(!String(e.message).includes("duplicate column")) throw e; }
}
addColumn("users","premium_started_at","TEXT");
addColumn("users","premium_disabled_at","TEXT");
addColumn("users","active","INTEGER NOT NULL DEFAULT 1");

const defaults={
 whatsapp:"2250152171974",
 paymentWhatsapp:"2250152171974",
 telegram:"@Sdrive12",
 whatsappGroup:"https://chat.whatsapp.com/GikWdoQLZ8TFDHK2rTHH8T?s=cl&p=a&mlu=4&ilr=4",
 telegramGroup:"https://t.me/sdrive123",
 tiktok:"https://www.tiktok.com/@batelemi92?_r=1&_t=ZS-99cD47Jhd00",
 facebook:"https://www.facebook.com/share/1L96SqLnZT/",
 instagram:"https://www.instagram.com/wonda_boss_officil?stkn=MWc0dndrYWp4c2o2cw==",
 wave500:"https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=500",
 wave1000:"https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=1000",
 orangeMoney:"",
 moovMoney:"",
 mtnMoney:"",
 bookmaker1Name:"1WIN", bookmaker1Bonus:"500%", bookmaker1Url:"https://1wyvrz.life/?p=gc9k",
 bookmaker2Name:"PARIPESA", bookmaker2Bonus:"500%", bookmaker2Url:"https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651",
 bookmaker3Name:"AFROPARI", bookmaker3Bonus:"300%", bookmaker3Url:"https://apaff.top/L?tag=d_3763651m_70055c_&site=3763651&ad=70055",
 bookmaker4Name:"MELBET", bookmaker4Bonus:"200%", bookmaker4Url:"https://refpa3665.com/L?tag=d_4685320m_66335c_&site=4685320&ad=66335",
 bookmaker5Name:"LOTO", bookmaker5Bonus:"", bookmaker5Url:"https://jdnlotto.com/register?promo=123",
 adminPhone:process.env.ADMIN_PHONE || "2250152171974"
};
const getSetting=DB.prepare("SELECT value FROM settings WHERE key=?");
const setSetting=DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
for(const [k,v] of Object.entries(defaults)) if(!getSetting.get(k)) setSetting.run(k,String(v));
if(!getSetting.get("adminPasswordHash")) setSetting.run("adminPasswordHash",bcrypt.hashSync(process.env.ADMIN_PASSWORD||"ChangeMe123!",12));

function getSettings(){return Object.fromEntries(DB.prepare("SELECT key,value FROM settings").all().map(x=>[x.key,x.value]));}
function cleanPhone(v){return String(v||"").replace(/\D/g,"");}
function now(){return new Date().toISOString();}
function today(){return now().slice(0,10);}
function isPremium(u){return !!(u.premium_until && new Date(u.premium_until)>new Date());}
function userView(u){
 if(!u) return null;
 const active=isPremium(u);
 return {id:u.id,username:u.username,name:u.username,phone:u.phone||"",active:!!u.active,premium_until:u.premium_until||null,premium_started_at:u.premium_started_at||null,premium_disabled_at:u.premium_disabled_at||null,is_subscribed:active,subscribed:active,subscription_active:active,created_at:u.created_at};
}
function requireUser(req,res,next){
 if(!req.session.userId) return res.status(401).json({error:"Connexion requise."});
 const u=DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
 if(!u || !u.active) return res.status(403).json({error:"Compte désactivé ou supprimé."});
 next();
}
function requireAdmin(req,res,next){if(!req.session.admin) return res.status(401).json({error:"Accès administrateur refusé."});next();}
function requireOwner(req,res,next){if(!req.session.admin || !req.session.adminOwner) return res.status(403).json({error:"Cette action est réservée à l'administrateur principal."});next();}

app.use(session({store:new SQLiteStore({db:"sessions.sqlite",dir:__dirname}),secret:process.env.SESSION_SECRET||"CHANGE_THIS_SECRET_IN_PRODUCTION",resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:7*24*60*60*1000}}));

app.get("/api/health",(req,res)=>res.json({ok:true,service:"S-Drive",time:now()}));

app.post("/api/register",(req,res)=>{
 const username=String(req.body.username||"").trim(); const password=String(req.body.password||"");
 if(username.length<3||password.length<6) return res.status(400).json({error:"Nom d'utilisateur valide et mot de passe de 6 caractères minimum requis."});
 try{
  const r=DB.prepare("INSERT INTO users(username,phone,password_hash,created_at,active) VALUES(?,?,?,?,1)").run(username,"",bcrypt.hashSync(password,12),now());
  const u=DB.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
  req.session.userId=Number(r.lastInsertRowid);
  res.status(201).json({message:"Compte créé avec succès.",user:userView(u)});
 }catch(e){res.status(409).json({error:"Ce nom d'utilisateur existe déjà."});}
});

app.post("/api/login",(req,res)=>{
 const username=String(req.body.username||"").trim(), password=String(req.body.password||"");
 const u=DB.prepare("SELECT * FROM users WHERE username=?").get(username);
 if(!u||!u.active||!bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:u&&!u.active?"Compte désactivé.":"Identifiants incorrects."});
 req.session.userId=u.id; res.json({message:"Connexion réussie.",user:userView(u)});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({message:"Déconnexion réussie."})));
app.get("/api/me",requireUser,(req,res)=>res.json({user:userView(DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId))}));
app.get("/api/session",(req,res)=>{
 if(req.session.userId){const u=DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId); if(u&&u.active) return res.json({authenticated:true,user:userView(u)});}
 res.json({authenticated:false});
});

app.post("/api/password-reset",(req,res)=>{
 const username=String(req.body.username||"").trim(); const u=DB.prepare("SELECT id FROM users WHERE username=?").get(username);
 if(!u)return res.status(404).json({error:"Utilisateur introuvable avec ces informations."});
 const pending=DB.prepare("SELECT id FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(u.id);
 if(!pending)DB.prepare("INSERT INTO password_resets(user_id,created_at) VALUES(?,?)").run(u.id,now());
 const phone=cleanPhone(getSettings().whatsapp||defaults.whatsapp);
 res.json({message:"Demande envoyée à l'administration.",whatsapp_url:phone?`https://wa.me/${phone}?text=${encodeURIComponent("Bonjour S-Drive 👋\n\nJe souhaite réinitialiser mon mot de passe.\n\nNom d'utilisateur : "+username)}`:""});
});
app.post("/api/forgot-password",(req,res)=>{
 const username=String(req.body.username||"").trim();
 const u=DB.prepare("SELECT id FROM users WHERE username=?").get(username);
 if(!u)return res.status(404).json({error:"Utilisateur introuvable avec ces informations."});
 const pending=DB.prepare("SELECT id FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(u.id);
 if(!pending)DB.prepare("INSERT INTO password_resets(user_id,created_at) VALUES(?,?)").run(u.id,now());
 res.json({message:"Demande envoyée à l'administration."});
});

app.get("/api/daily-matches",requireUser,(req,res)=>res.json({matches:DB.prepare("SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC").all(today())}));
app.post("/api/analysis-requests",requireUser,(req,res)=>{
 const type=req.body.type==="loto"?"loto":"football", content=String(req.body.content||"").trim();
 if(!content)return res.status(400).json({error:type==="loto"?"Envoyez les trois derniers résultats du tirage.":"Écrivez les matchs à analyser."});
 const id=DB.prepare("INSERT INTO analysis_requests(user_id,type,content,created_at) VALUES(?,?,?,?)").run(req.session.userId,type,content,now()).lastInsertRowid;
 const s=getSettings(), phone=cleanPhone(s.whatsapp), label=type==="loto"?"Loto":"Football";
 const text=`Bonjour S-Drive 👋\n\nJe souhaite demander une analyse ${label}.\n\n${content}\n\nRéférence : S-Drive #${id}`;
 res.status(201).json({message:"Demande enregistrée.",request_id:Number(id),whatsapp:phone?`https://wa.me/${phone}?text=${encodeURIComponent(text)}`:"",telegram:s.telegram?`https://t.me/${String(s.telegram).replace(/^@/,"")}`:""});
});

app.post("/api/admin/login",(req,res)=>{
 const s=getSettings(), phone=cleanPhone(req.body.phone), password=String(req.body.password||"");
 const main=phone===cleanPhone(s.adminPhone)&&s.adminPasswordHash&&bcrypt.compareSync(password,s.adminPasswordHash);
 const agent=DB.prepare("SELECT * FROM agents WHERE phone=? AND active=1").get(phone);
 const agentOk=agent&&bcrypt.compareSync(password,agent.password_hash);
 if(!main&&!agentOk)return res.status(401).json({error:"Accès administrateur refusé."});
 req.session.admin=true; req.session.adminOwner=!!main; req.session.adminName=main?"Administrateur":agent.name; req.session.save(err=>err?res.status(500).json({error:"Impossible d'ouvrir la session administrateur."}):res.json({message:"Administration ouverte.",name:req.session.adminName}));
});
app.get("/api/admin/me",(req,res)=>req.session.admin?res.json({admin:true,name:req.session.adminName||"Administrateur"}):res.status(401).json({error:"Non connecté."}));
app.post("/api/admin/logout",(req,res)=>req.session.destroy(()=>res.json({message:"Administration déconnectée."})));

app.get("/api/admin/stats",requireAdmin,(req,res)=>res.json({users:DB.prepare("SELECT COUNT(*) n FROM users").get().n,analyses:DB.prepare("SELECT COUNT(*) n FROM analysis_requests").get().n,pending:DB.prepare("SELECT COUNT(*) n FROM analysis_requests WHERE status='pending'").get().n,password_resets:DB.prepare("SELECT COUNT(*) n FROM password_resets WHERE status='pending'").get().n,agents:DB.prepare("SELECT COUNT(*) n FROM agents WHERE active=1").get().n}));
app.get("/api/admin/users",requireAdmin,(req,res)=>res.json({users:DB.prepare("SELECT * FROM users ORDER BY id DESC").all().map(userView)}));
app.delete("/api/admin/users/:id",requireAdmin,(req,res)=>{const r=DB.prepare("DELETE FROM users WHERE id=?").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Utilisateur introuvable."});res.json({message:"Membre supprimé."});});
app.patch("/api/admin/users/:id/status",requireAdmin,(req,res)=>{const active=req.body.active!==false;const r=DB.prepare("UPDATE users SET active=? WHERE id=?").run(active?1:0,Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Utilisateur introuvable."});res.json({message:active?"Compte activé.":"Compte désactivé."});});

app.post("/api/admin/subscription",requireAdmin,(req,res)=>{
 const username=String(req.body.username||"").trim(); const id=Number(req.body.user_id); const active=!!req.body.active;
 const u=username?DB.prepare("SELECT * FROM users WHERE username=?").get(username):DB.prepare("SELECT * FROM users WHERE id=?").get(id);
 if(!u)return res.status(404).json({error:"Membre introuvable."});
 if(active){const started=now(), until=new Date(Date.now()+7*24*60*60*1000).toISOString();DB.prepare("UPDATE users SET premium_until=?,premium_started_at=?,premium_disabled_at=NULL WHERE id=?").run(until,started,u.id);return res.json({message:`Premium activé pour ${u.username} pendant 7 jours.`,user:userView(DB.prepare("SELECT * FROM users WHERE id=?").get(u.id))});}
 DB.prepare("UPDATE users SET premium_until=NULL,premium_disabled_at=? WHERE id=?").run(now(),u.id);res.json({message:`Premium désactivé pour ${u.username}.`,user:userView(DB.prepare("SELECT * FROM users WHERE id=?").get(u.id))});
});

app.post("/api/admin/reset-password",requireAdmin,(req,res)=>{const p=String(req.body.password||"");if(p.length<6)return res.status(400).json({error:"Minimum 6 caractères."});const r=DB.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(p,12),Number(req.body.user_id));if(!r.changes)return res.status(404).json({error:"Utilisateur introuvable."});res.json({message:"Mot de passe modifié avec succès."});});

function resetList(){return DB.prepare("SELECT pr.*,u.username,u.phone FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.status='pending' ORDER BY pr.id DESC").all();}
app.get("/api/admin/password-resets",requireAdmin,(req,res)=>res.json({requests:resetList()}));
app.get("/api/admin/reset-requests",requireAdmin,(req,res)=>res.json({requests:resetList()}));
app.post("/api/admin/reset-requests/:id/resolve",requireAdmin,(req,res)=>{
 const id=Number(req.params.id), r=DB.prepare("SELECT pr.*,u.username FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.id=?").get(id);
 if(!r)return res.status(404).json({error:"Demande introuvable."}); if(r.status!=="pending")return res.status(409).json({error:"Cette demande a déjà été traitée."});
 const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let p="SD-";for(let i=0;i<8;i++)p+=chars[crypto.randomInt(chars.length)];
 DB.transaction(()=>{DB.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(p,12),r.user_id);DB.prepare("UPDATE password_resets SET status='resolved' WHERE id=?").run(id);})();
 res.json({message:`Nouveau mot de passe généré pour ${r.username}.`,username:r.username,new_password:p});
});

app.get("/api/admin/settings",requireAdmin,(req,res)=>{const s=getSettings();delete s.adminPasswordHash;res.json({settings:s});});
app.patch("/api/admin/settings",requireAdmin,(req,res)=>{
 const allowed=["whatsapp","paymentWhatsapp","telegram","whatsappGroup","telegramGroup","tiktok","facebook","instagram","wave500","wave1000","orangeMoney","moovMoney","mtnMoney","adminPhone"];
 for(let i=1;i<=5;i++)allowed.push(`bookmaker${i}Name`,`bookmaker${i}Bonus`,`bookmaker${i}Url`);
 for(const k of allowed)if(req.body[k]!==undefined)setSetting.run(k,String(req.body[k]));
 res.json({message:"Configuration enregistrée.",settings:getSettings()});
});

app.get("/api/config",(req,res)=>{const s=getSettings();const bookmakers=[];for(let i=1;i<=5;i++)if(s[`bookmaker${i}Name`]||s[`bookmaker${i}Url`])bookmakers.push({name:s[`bookmaker${i}Name`]||"Bookmaker",bonus:s[`bookmaker${i}Bonus`]||"",url:s[`bookmaker${i}Url`]||""});res.json({...s,bookmakers});});

app.get("/api/admin/agents",requireAdmin,(req,res)=>res.json({agents:DB.prepare("SELECT id,name,phone,active,created_at FROM agents ORDER BY id DESC").all()}));
app.post("/api/admin/agents",requireOwner,(req,res)=>{const name=String(req.body.name||"").trim(),phone=cleanPhone(req.body.phone),password=String(req.body.password||"");if(!name||phone.length<8||password.length<6)return res.status(400).json({error:"Nom, téléphone et mot de passe valides requis."});try{DB.prepare("INSERT INTO agents(name,phone,password_hash,active,created_at) VALUES(?,?,?,?,?)").run(name,phone,bcrypt.hashSync(password,12),1,now());res.status(201).json({message:"Agent ajouté avec succès."});}catch(e){res.status(409).json({error:"Ce numéro est déjà utilisé par un agent."});}});
app.patch("/api/admin/agents/:id/status",requireOwner,(req,res)=>{const r=DB.prepare("UPDATE agents SET active=? WHERE id=?").run(req.body.active===false?0:1,Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Agent introuvable."});res.json({message:"Statut de l'agent mis à jour."});});
app.delete("/api/admin/agents/:id",requireOwner,(req,res)=>{const r=DB.prepare("DELETE FROM agents WHERE id=?").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Agent introuvable."});res.json({message:"Agent supprimé."});});

app.post("/api/admin/daily-matches",requireAdmin,(req,res)=>{const name=String(req.body.match_name||"").trim(),pick=String(req.body.recommended_pick||"").trim(),h=Number(req.body.home_probability),d=Number(req.body.draw_probability),a=Number(req.body.away_probability);if(!name||!pick||![h,d,a].every(Number.isFinite)||h<0||h>100||d<0||d>100||a<0||a>100||Math.abs(h+d+a-100)>0.01)return res.status(400).json({error:"Probabilités invalides : elles doivent totaliser 100 %."});DB.prepare("INSERT INTO daily_matches(match_name,home_probability,draw_probability,away_probability,recommended_pick,match_date,created_at) VALUES(?,?,?,?,?,?,?)").run(name,h,d,a,pick,today(),now());res.status(201).json({message:"Match ajouté avec succès."});});
app.get("/api/admin/daily-matches",requireAdmin,(req,res)=>res.json({matches:DB.prepare("SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC").all(today())}));
app.delete("/api/admin/daily-matches/:id",requireAdmin,(req,res)=>{DB.prepare("DELETE FROM daily_matches WHERE id=?").run(Number(req.params.id));res.json({message:"Match supprimé."});});

app.get("/api/admin/requests",requireAdmin,(req,res)=>res.json({requests:DB.prepare("SELECT ar.*,u.username,u.phone FROM analysis_requests ar LEFT JOIN users u ON u.id=ar.user_id ORDER BY ar.id DESC").all()}));
app.patch("/api/admin/requests/:id",requireAdmin,(req,res)=>{const allowed=["pending","processing","completed","cancelled"];const status=allowed.includes(req.body.status)?req.body.status:"pending";DB.prepare("UPDATE analysis_requests SET status=? WHERE id=?").run(status,Number(req.params.id));res.json({message:"Demande mise à jour."});});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`S-Drive démarré sur le port ${PORT}`));
