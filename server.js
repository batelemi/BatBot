const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set("trust proxy", 1);

const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "2250152171974";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "2250152171974";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(express.json({limit:"8mb"}));
app.use(express.urlencoded({extended:false, limit:"8mb"}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const db = new Database(path.join(__dirname, "sdrive.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  badge TEXT NOT NULL DEFAULT 'Membre S-Drive',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
CREATE TABLE IF NOT EXISTS daily_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_name TEXT NOT NULL,
  home_probability REAL NOT NULL,
  draw_probability REAL NOT NULL,
  away_probability REAL NOT NULL,
  recommended_pick TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

if (!hasColumn("users", "username")) {
  db.exec("ALTER TABLE users ADD COLUMN username TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");

const usersWithoutUsername = db.prepare(
  "SELECT id,name FROM users WHERE username IS NULL OR TRIM(username)=''"
).all();
const setLegacyUsername = db.prepare("UPDATE users SET username=? WHERE id=?");
for (const u of usersWithoutUsername) {
  let base = String(u.name || "user").trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "user";
  let candidate = base;
  let n = 1;
  while (db.prepare("SELECT id FROM users WHERE username=? AND id<>?").get(candidate, u.id)) {
    candidate = `${base}_${n++}`;
  }
  setLegacyUsername.run(candidate, u.id);
}

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase();
}
function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(String(value || "").trim());
}
function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username=?").get(cleanUsername(username));
}
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare(
    "SELECT id,username,name,badge,created_at,premium_until FROM users WHERE id=?"
  ).get(req.session.userId);
}
function safeUser(u) {
  if (!u) return null;
  const premiumUntil = u.premium_until || null;
  const active = Boolean(premiumUntil && new Date(premiumUntil).getTime() > Date.now());
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    badge: active ? "Premium" : (u.badge || "Membre S-Drive"),
    is_subscribed: active,
    subscription_active: active,
    premium_until: premiumUntil,
    created_at: u.created_at
  };
}
function requireAuth(req,res,next) {
  if (!req.session.userId) return res.status(401).json({success:false,error:"Connexion requise."});
  next();
}
function requireAdmin(req,res,next) {
  if (!req.session.admin) return res.status(403).json({success:false,error:"Accès administrateur requis."});
  next();
}
function whatsappLink(message) {
  const n = String(WHATSAPP_NUMBER).replace(/[^\d]/g,"");
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : null;
}
function sessionSave(req) {
  return new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
}

/* API CLIENT */
app.post("/api/register", async (req,res)=>{
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    if (!validUsername(username))
      return res.status(400).json({success:false,error:"Le nom d'utilisateur doit contenir 3 à 30 caractères (lettres, chiffres, _, -, .)."});
    if (password.length < 6)
      return res.status(400).json({success:false,error:"Le mot de passe doit contenir au moins 6 caractères."});
    if (getUserByUsername(username))
      return res.status(409).json({success:false,error:"Ce nom d'utilisateur existe déjà. Choisissez-en un autre."});

    const hash = await bcrypt.hash(password,10);
    // The legacy database may still require a unique phone value.
    // A technical internal value is used; the client never supplies or sees a phone number.
    const internalPhone = `user:${username}`;
    const result = db.prepare(
      "INSERT INTO users(username,name,phone,password_hash,badge) VALUES(?,?,?,?,?)"
    ).run(username, username, internalPhone, hash, "Membre S-Drive");

    req.session.userId = Number(result.lastInsertRowid);
    await sessionSave(req);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(result.lastInsertRowid);
    res.status(201).json({success:true,message:"Compte créé avec succès.",user:safeUser(u)});
  } catch(e) {
    console.error("REGISTER",e);
    res.status(500).json({success:false,error:"Erreur serveur lors de la création du compte."});
  }
});

app.post("/api/login", async (req,res)=>{
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    const u = getUserByUsername(username);
    if (!u || !(await bcrypt.compare(password,u.password_hash)))
      return res.status(401).json({success:false,error:"Nom d'utilisateur ou mot de passe incorrect."});
    req.session.userId = u.id;
    await sessionSave(req);
    res.json({success:true,user:safeUser(u)});
  } catch(e) {
    console.error("LOGIN",e);
    res.status(500).json({success:false,error:"Erreur serveur."});
  }
});

app.post("/api/password-reset", (req,res)=>{
  const username = cleanUsername(req.body.username);
  if (!username) return res.status(400).json({success:false,error:"Entrez votre nom d'utilisateur."});
  const u = getUserByUsername(username);
  if (!u) {
    return res.json({success:true,message:"Si ce compte existe, la demande a été transmise à l'administrateur."});
  }
  db.prepare("INSERT INTO password_resets(user_id,status) VALUES(?,'pending')").run(u.id);
  res.json({
    success:true,
    message:"Votre demande de réinitialisation a été enregistrée.",
    whatsapp_url: whatsappLink(`Bonjour S-Drive 👋\n\nJe souhaite réinitialiser mon mot de passe.\n\nNom d'utilisateur : ${username}`)
  });
});

app.get("/api/me",(req,res)=>{
  const u=currentUser(req);
  if (!u) return res.status(401).json({success:false,error:"Non connecté."});
  res.json({success:true,user:safeUser(u)});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({success:true})));

app.get("/api/daily-matches",requireAuth,(req,res)=>{
  res.json({success:true,matches:db.prepare(
    "SELECT * FROM daily_matches ORDER BY id DESC"
  ).all()});
});

/* API ADMIN */
app.get("/api/admin/me",(req,res)=>{
  if (!req.session.admin) return res.status(401).json({success:false,error:"Non connecté."});
  res.json({success:true,admin:true});
});

app.post("/api/admin/login",async(req,res)=>{
  const phone = String(req.body.phone || "").replace(/[^\d+]/g,"");
  const password = String(req.body.password || "");
  const normalizedAdmin = String(ADMIN_PHONE).replace(/[^\d+]/g,"");
  if (!ADMIN_PASSWORD)
    return res.status(503).json({success:false,error:"Le mot de passe administrateur n'est pas configuré dans Render (ADMIN_PASSWORD)."});
  if (phone !== normalizedAdmin || password !== ADMIN_PASSWORD)
    return res.status(401).json({success:false,error:"Identifiants administrateur incorrects."});
  req.session.admin = true;
  await sessionSave(req);
  res.json({success:true});
});

app.post("/api/admin/logout",(req,res)=>{
  req.session.admin = false;
  req.session.save(()=>res.json({success:true}));
});

app.get("/api/admin/users",requireAdmin,(req,res)=>{
  const users = db.prepare(
    "SELECT id,username,name,badge,created_at,premium_until FROM users ORDER BY id DESC"
  ).all().map(u=>({...safeUser(u)}));
  res.json({success:true,users});
});

app.post("/api/admin/users/:id/premium",requireAdmin,(req,res)=>{
  const id = Number(req.params.id);
  const enabled = Boolean(req.body.enabled);
  const u = db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if (!u) return res.status(404).json({success:false,error:"Utilisateur introuvable."});
  if (enabled) {
    const until = new Date(Date.now()+7*24*60*60*1000).toISOString();
    db.prepare("UPDATE users SET premium_until=?, badge='Premium' WHERE id=?").run(until,id);
  } else {
    db.prepare("UPDATE users SET premium_until=NULL, badge='Membre S-Drive' WHERE id=?").run(id);
  }
  const updated = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  res.json({success:true,user:safeUser(updated)});
});

app.delete("/api/admin/users/:id",requireAdmin,(req,res)=>{
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM users WHERE id=?").run(id);
  if (!result.changes) return res.status(404).json({success:false,error:"Utilisateur introuvable."});
  res.json({success:true,message:"Utilisateur supprimé."});
});

app.get("/api/admin/reset-requests",requireAdmin,(req,res)=>{
  const requests = db.prepare(`
    SELECT pr.id, pr.user_id, pr.status, pr.created_at,
           u.username, u.name
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.status='pending'
    ORDER BY pr.id DESC
  `).all();
  res.json({success:true,requests});
});

app.post("/api/admin/reset-requests/:id/resolve",requireAdmin,(req,res)=>{
  const request = db.prepare(`
    SELECT pr.id,pr.user_id,u.username,u.name
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.id=? AND pr.status='pending'
  `).get(Number(req.params.id));
  if (!request) return res.status(404).json({success:false,error:"Demande introuvable."});

  const temporary = "SD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const hash = bcrypt.hashSync(temporary,10);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash,request.user_id);
  db.prepare("UPDATE password_resets SET status='resolved',admin_password_hash=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(hash,request.id);

  res.json({
    success:true,
    message:`Réinitialisation terminée pour ${request.username}.`,
    new_password:temporary,
    whatsapp_url:whatsappLink(
      `Bonjour ${request.username} 👋\n\nVotre mot de passe temporaire S-Drive est : ${temporary}`
    )
  });
});

app.post("/api/admin/daily-matches",requireAdmin,(req,res)=>{
  const name = String(req.body.match_name || req.body.name || "").trim();
  const home = Number(req.body.home_probability);
  const draw = Number(req.body.draw_probability);
  const away = Number(req.body.away_probability);
  const pick = String(req.body.recommended_pick || "").trim();
  if (!name) return res.status(400).json({success:false,error:"Entrez le nom du match."});
  if (![home,draw,away].every(Number.isFinite))
    return res.status(400).json({success:false,error:"Probabilités invalides."});
  if ([home,draw,away].some(v=>v<0 || v>100))
    return res.status(400).json({success:false,error:"Chaque probabilité doit être comprise entre 0 et 100 %."});
  if (Math.abs(home+draw+away-100)>0.01)
    return res.status(400).json({success:false,error:"Les probabilités doivent avoir un total de 100 %."});
  const result = db.prepare(`
    INSERT INTO daily_matches(match_name,home_probability,draw_probability,away_probability,recommended_pick)
    VALUES(?,?,?,?,?)
  `).run(name,home,draw,away,pick);
  res.status(201).json({success:true,message:"Match ajouté avec succès.",id:Number(result.lastInsertRowid)});
});

app.get("/api/admin/daily-matches",requireAdmin,(req,res)=>{
  res.json({success:true,matches:db.prepare("SELECT * FROM daily_matches ORDER BY id DESC").all()});
});

app.delete("/api/admin/daily-matches/:id",requireAdmin,(req,res)=>{
  const result = db.prepare("DELETE FROM daily_matches WHERE id=?").run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({success:false,error:"Match introuvable."});
  res.json({success:true,message:"Match supprimé avec succès."});
});

app.get("/api/health",(req,res)=>res.json({success:true,message:"S-Drive fonctionne correctement."}));

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.use((req,res)=>{
  if (req.path.startsWith("/api/"))
    return res.status(404).json({success:false,error:"Route API introuvable."});
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(PORT,"0.0.0.0",()=>console.log(`S-Drive démarré sur 0.0.0.0:${PORT}`));
