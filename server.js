const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const DB = new Database(path.join(__dirname, "sdrive.db"));

app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

DB.pragma("journal_mode = WAL");
DB.pragma("foreign_keys = ON");

DB.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT "",
  password_hash TEXT NOT NULL,
  premium_until TEXT,
  premium_started_at TEXT,
  ai_until TEXT,
  ai_started_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  delivery_token TEXT,
  temporary_password_encrypted TEXT,
  temporary_password_expires_at TEXT,
  resolved_at TEXT,
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
CREATE TABLE IF NOT EXISTS payment_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  offer TEXT NOT NULL,
  operator TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bookmakers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  bonus TEXT DEFAULT "",
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coupons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_name TEXT NOT NULL,
  code TEXT NOT NULL,
  platform_url TEXT NOT NULL,
  description TEXT DEFAULT "",
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS batbot_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batbot_message_reads(
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(message_id,user_id),
  FOREIGN KEY(message_id) REFERENCES batbot_messages(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS member_predictions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_probability REAL NOT NULL,
  draw_probability REAL NOT NULL,
  away_probability REAL NOT NULL,
  prediction TEXT NOT NULL,
  coupon_code TEXT DEFAULT "",
  bookmaker TEXT DEFAULT "",
  comment TEXT DEFAULT "",
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

DB.exec(`
CREATE INDEX IF NOT EXISTS idx_member_predictions_user_created ON member_predictions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_predictions_created ON member_predictions(created_at DESC);
`);

// Migrations pour les bases déjà existantes
try { DB.prepare("ALTER TABLE users ADD COLUMN premium_started_at TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN ai_until TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN ai_started_at TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN temporary_password_hash TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN temporary_password_expires_at TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE password_resets ADD COLUMN delivery_token TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE password_resets ADD COLUMN temporary_password_encrypted TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE password_resets ADD COLUMN temporary_password_expires_at TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE password_resets ADD COLUMN resolved_at TEXT").run(); } catch (_) {}

const defaults = {
  whatsapp: "2250152171974",
  telegram: "@BatBot12",
  whatsappGroup: "https://chat.whatsapp.com/GikWdoQLZ8TFDHK2rTHH8T?s=cl&p=a&mlu=4&ilr=4",
  telegramGroup: "https://t.me/sdrive123",
  tiktok: "https://www.tiktok.com/@batelemi92?_r=1&_t=ZS-99cD47Jhd00",
  facebook: "https://www.facebook.com/share/1L96SqLnZT/",
  instagram: "https://www.instagram.com/wonda_boss_officil?stkn=MWc0dndrYWp4c2o2cw==",
  wave500: "https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=500",
  wave1000: "https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=1000",
  wavePromo: "WAVE22",
  promoFee: "45CFA",
  orangeMoney: "0759060289",
  moovMoney: "0152171974",
  mtnMoney: "0554740711",
  sdriveLink: "",
  sdriveInviteMessage: "Invite tes amis à rejoindre BatBot et profite de tes avantages.",
  adminPhone: process.env.ADMIN_PHONE || "2250152171974"
};

const getSetting = DB.prepare("SELECT value FROM settings WHERE key=?");
const setSetting = DB.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
for (const [key, value] of Object.entries(defaults)) {
  if (!getSetting.get(key)) setSetting.run(key, String(value));
}

// Correction automatique des anciennes coordonnées WhatsApp/admin enregistrées
// dans la base de données lors d'une précédente version.
try {
  const oldNumber = "2250152171974";
  const newNumber = "2250152171974";
  const currentWhatsapp = getSetting.get("whatsapp");
  const currentAdminPhone = getSetting.get("adminPhone");
  if (currentWhatsapp && String(currentWhatsapp.value) === oldNumber) {
    setSetting.run("whatsapp", newNumber);
  }
  if (currentAdminPhone && String(currentAdminPhone.value) === oldNumber) {
    setSetting.run("adminPhone", newNumber);
  }
} catch (_) {}

if (!getSetting.get("adminPasswordHash")) {
  setSetting.run(
    "adminPasswordHash",
    bcrypt.hashSync(process.env.ADMIN_PASSWORD || "ChangeMe123!", 12)
  );
}

function getSettings() {
  return Object.fromEntries(
    DB.prepare("SELECT key,value FROM settings").all().map(x => [x.key, x.value])
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

const PASSWORD_RESET_SECRET = crypto.createHash("sha256")
  .update(String(process.env.SESSION_SECRET || "CHANGE_THIS_SECRET_IN_PRODUCTION"))
  .digest();

function encryptTemporaryPassword(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", PASSWORD_RESET_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptTemporaryPassword(value) {
  const [ivText, tagText, encryptedText] = String(value || "").split(".");
  if (!ivText || !tagText || !encryptedText) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", PASSWORD_RESET_SECRET, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch (_) {
    return null;
  }
}

function userView(user) {
  if (!user) return null;
  const active = !!(user.premium_until && new Date(user.premium_until) > new Date());
  const aiActive = !!(user.ai_until && new Date(user.ai_until) > new Date());
  return {
    id: user.id,
    username: user.username,
    name: user.username,
    phone: user.phone,
    premium_until: user.premium_until,
    premium_started_at: user.premium_started_at || null,
    ai_until: user.ai_until || null,
    ai_started_at: user.ai_started_at || null,
    ai_active: aiActive && active && !Boolean(user.disabled),
    disabled: Boolean(user.disabled),
    must_change_password: Boolean(user.must_change_password),
    is_subscribed: active && !Boolean(user.disabled),
    subscribed: active,
    subscription_active: active,
    created_at: user.created_at
  };
}

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Connexion requise." });
  }
  const user = DB.prepare("SELECT id, disabled FROM users WHERE id=?").get(req.session.userId);
  if (!user || user.disabled) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Ce compte est désactivé ou introuvable." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: "Accès administrateur refusé." });
  }
  next();
}

app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: __dirname }),
  secret: process.env.SESSION_SECRET || "CHANGE_THIS_SECRET_IN_PRODUCTION",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "BatBot", time: new Date().toISOString() });
});

app.post("/api/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || password.length < 6) {
    return res.status(400).json({
      error: "Nom d'utilisateur et mot de passe valides requis (6 caractères minimum)."
    });
  }

  try {
    const result = DB.prepare(
      "INSERT INTO users(username,phone,password_hash) VALUES(?,?,?)"
    ).run(username, "", bcrypt.hashSync(password, 12));

    req.session.userId = Number(result.lastInsertRowid);
    const user = DB.prepare("SELECT * FROM users WHERE id=?").get(result.lastInsertRowid);
    res.status(201).json({ message: "Compte créé avec succès.", user: userView(user) });
  } catch (error) {
    res.status(409).json({ error: "Ce nom d'utilisateur existe déjà." });
  }
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = DB.prepare("SELECT * FROM users WHERE username=?").get(username);

  if (!user || user.disabled) {
    return res.status(401).json({ error: "Identifiants incorrects ou compte désactivé." });
  }

  let validPassword = false;
  let temporaryLogin = false;

  if (user.must_change_password) {
    const expiresAt = user.temporary_password_expires_at ? new Date(user.temporary_password_expires_at) : null;
    if (!expiresAt || expiresAt <= new Date() || !user.temporary_password_hash) {
      return res.status(401).json({ error: "Votre mot de passe temporaire a expiré. Faites une nouvelle demande." });
    }
    validPassword = bcrypt.compareSync(password, user.temporary_password_hash);
    temporaryLogin = validPassword;
  } else {
    validPassword = bcrypt.compareSync(password, user.password_hash);
  }

  if (!validPassword) {
    return res.status(401).json({ error: "Identifiants incorrects ou compte désactivé." });
  }

  req.session.userId = user.id;
  res.json({
    message: temporaryLogin ? "Connexion temporaire réussie. Nouveau mot de passe requis." : "Connexion réussie.",
    temporary_login: temporaryLogin,
    must_change_password: Boolean(user.must_change_password),
    user: userView(user)
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Déconnexion réussie." }));
});

app.get("/api/me", requireUser, (req, res) => {
  const user = DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Session invalide." });
  res.json({ user: userView(user) });
});

app.post("/api/password-reset", (req, res) => {
  const username = String(req.body.username || "").trim();
  const user = DB.prepare("SELECT id, disabled FROM users WHERE username=?").get(username);

  if (!user || user.disabled) {
    return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
  }

  let request = DB.prepare(
    "SELECT id, delivery_token, status FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (!request) {
    const deliveryToken = crypto.randomBytes(32).toString("hex");
    const result = DB.prepare(
      "INSERT INTO password_resets(user_id,delivery_token) VALUES(?,?)"
    ).run(user.id, deliveryToken);
    request = { id: Number(result.lastInsertRowid), delivery_token: deliveryToken, status: "pending" };
  } else if (!request.delivery_token) {
    request.delivery_token = crypto.randomBytes(32).toString("hex");
    DB.prepare("UPDATE password_resets SET delivery_token=? WHERE id=?").run(request.delivery_token, request.id);
  }

  res.json({
    message: "Demande bien envoyée au service BatBot. Veuillez patienter pendant le traitement ; votre mot de passe temporaire apparaîtra automatiquement ici dès qu’il sera prêt.",
    request_id: request.id,
    request_token: request.delivery_token
  });
});

// Compatibilité avec les anciennes versions de l'interface.
app.post("/api/forgot-password", (req, res) => {
  const username = String(req.body.username || "").trim();
  const user = DB.prepare("SELECT id, disabled FROM users WHERE username=?").get(username);

  if (!user || user.disabled) {
    return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
  }

  let existing = DB.prepare(
    "SELECT id, delivery_token FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (!existing) {
    const deliveryToken = crypto.randomBytes(32).toString("hex");
    const result = DB.prepare("INSERT INTO password_resets(user_id,delivery_token) VALUES(?,?)").run(user.id, deliveryToken);
    existing = { id: Number(result.lastInsertRowid), delivery_token: deliveryToken };
  } else if (!existing.delivery_token) {
    existing.delivery_token = crypto.randomBytes(32).toString("hex");
    DB.prepare("UPDATE password_resets SET delivery_token=? WHERE id=?").run(existing.delivery_token, existing.id);
  }

  res.json({ message: "Demande bien envoyée au service BatBot. Veuillez patienter pendant le traitement ; votre mot de passe temporaire apparaîtra automatiquement ici dès qu’il sera prêt.", request_id: existing.id, request_token: existing.delivery_token });
});

// Vérification sécurisée de la demande depuis l'espace de connexion.
// Le token est un secret temporaire conservé uniquement dans la session locale du navigateur.
app.get("/api/password-reset/status", (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token || token.length < 40) return res.status(400).json({ error: "Jeton de récupération invalide." });

  const request = DB.prepare(`
    SELECT pr.id, pr.status, pr.temporary_password_encrypted, pr.temporary_password_expires_at,
           u.username, u.disabled, u.must_change_password
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.delivery_token=?
    ORDER BY pr.id DESC LIMIT 1
  `).get(token);

  if (!request || request.disabled) return res.status(404).json({ error: "Demande introuvable." });

  if (request.status === "pending") {
    return res.json({ status: "pending", username: request.username });
  }

  const expiresAt = request.temporary_password_expires_at ? new Date(request.temporary_password_expires_at) : null;
  if (!expiresAt || expiresAt <= new Date()) {
    return res.json({ status: "expired", username: request.username });
  }

  const temporaryPassword = decryptTemporaryPassword(request.temporary_password_encrypted);
  if (!temporaryPassword) return res.status(500).json({ error: "Impossible de récupérer le mot de passe temporaire." });

  res.json({
    status: "ready",
    username: request.username,
    temporary_password: temporaryPassword,
    expires_at: request.temporary_password_expires_at
  });
});

app.post("/api/password-change", requireUser, (req, res) => {
  const password = String(req.body.password || "");
  const confirmation = String(req.body.confirm_password || "");

  if (password.length < 6) return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
  if (password !== confirmation) return res.status(400).json({ error: "Les deux mots de passe ne correspondent pas." });

  const user = DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  if (!user || user.disabled) return res.status(403).json({ error: "Compte indisponible." });

  const result = DB.prepare(`
    UPDATE users
    SET password_hash=?, must_change_password=0, temporary_password_hash=NULL, temporary_password_expires_at=NULL
    WHERE id=?
  `).run(bcrypt.hashSync(password, 12), user.id);

  if (!result.changes) return res.status(500).json({ error: "Impossible de modifier le mot de passe." });

  res.json({ message: "Votre nouveau mot de passe a été enregistré avec succès.", user: userView(DB.prepare("SELECT * FROM users WHERE id=?").get(user.id)) });
});

app.get("/api/daily-matches", requireUser, (req, res) => {
  res.json({
    matches: DB.prepare(
      "SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC"
    ).all(today())
  });
});

app.post("/api/analysis-requests", requireUser, (req, res) => {
  const type = req.body.type === "loto" ? "loto" : "football";
  const content = String(req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({
      error: type === "loto"
        ? "Envoyez les trois derniers résultats du tirage à analyser."
        : "Écrivez les matchs ou informations à analyser."
    });
  }

  if (type === "loto" && content.length < 10) {
    return res.status(400).json({
      error: "Pour une analyse Loto, indiquez les 3 derniers résultats du tirage."
    });
  }

  const id = DB.prepare(
    "INSERT INTO analysis_requests(user_id,type,content) VALUES(?,?,?)"
  ).run(req.session.userId, type, content).lastInsertRowid;

  const settings = getSettings();
  const phone = cleanPhone(settings.whatsapp);
  const label = type === "loto" ? "Loto" : "Football";
  const text =
    `Bonjour BatBot 👋\n\n` +
    `Je souhaite demander une analyse ${label}.\n\n` +
    `${content}\n\n` +
    `Référence de ma demande : BatBot #${id}`;

  res.status(201).json({
    message: "Demande enregistrée.",
    request_id: Number(id),
    whatsapp: phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : "",
    telegram: settings.telegram
      ? `https://t.me/${String(settings.telegram).replace(/^@/, "")}`
      : ""
  });
});

function cleanupExpiredBatBotMessages(){
  try{
    DB.prepare("DELETE FROM batbot_messages WHERE expires_at <= CURRENT_TIMESTAMP").run();
  }catch(error){
    console.error("BATBOT MESSAGE CLEANUP:",error.message);
  }
}

cleanupExpiredBatBotMessages();
setInterval(cleanupExpiredBatBotMessages, 5 * 60 * 1000).unref();

app.get("/api/messages/mine", requireUser, (req, res) => {
  cleanupExpiredBatBotMessages();
  const messages=DB.prepare(`
    SELECT m.id,m.title,m.body,m.created_at,m.expires_at,
           CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END AS is_read
    FROM batbot_messages m
    LEFT JOIN batbot_message_reads r ON r.message_id=m.id AND r.user_id=?
    WHERE m.expires_at > CURRENT_TIMESTAMP
    ORDER BY m.id DESC
  `).all(req.session.userId).map(x=>({...x,is_read:Boolean(x.is_read)}));
  res.json({messages});
});

app.post("/api/messages/:id/read", requireUser, (req, res) => {
  cleanupExpiredBatBotMessages();
  const id=Number(req.params.id);
  const message=DB.prepare("SELECT id FROM batbot_messages WHERE id=? AND expires_at>CURRENT_TIMESTAMP").get(id);
  if(!message)return res.status(404).json({error:"Message introuvable ou expiré."});
  DB.prepare("INSERT OR IGNORE INTO batbot_message_reads(message_id,user_id) VALUES(?,?)").run(id,req.session.userId);
  res.json({message:"Message marqué comme lu."});
});

app.get("/api/admin/messages", requireAdmin, (req, res) => {
  cleanupExpiredBatBotMessages();
  const messages=DB.prepare(`
    SELECT id,title,body,created_at,expires_at
    FROM batbot_messages
    WHERE expires_at>CURRENT_TIMESTAMP
    ORDER BY id DESC
  `).all();
  res.json({messages});
});

app.post("/api/admin/messages", requireAdmin, (req, res) => {
  const title=String(req.body.title||"").trim();
  const body=String(req.body.body||"").trim();
  if(!title||!body)return res.status(400).json({error:"Le titre et le contenu du message sont obligatoires."});
  if(title.length>120)return res.status(400).json({error:"Le titre ne doit pas dépasser 120 caractères."});
  if(body.length>2000)return res.status(400).json({error:"Le contenu ne doit pas dépasser 2000 caractères."});
  cleanupExpiredBatBotMessages();
  const result=DB.prepare("INSERT INTO batbot_messages(title,body,created_at,expires_at) VALUES(?,?,CURRENT_TIMESTAMP,datetime('now','+24 hours'))")
    .run(title,body);
  const created=DB.prepare("SELECT id,title,body,created_at,expires_at FROM batbot_messages WHERE id=?").get(Number(result.lastInsertRowid));
  res.status(201).json({message:"Message publié avec succès. Il restera visible pendant 24 heures.",id:Number(result.lastInsertRowid),expires_at:created.expires_at});
});

app.delete("/api/admin/messages/:id", requireAdmin, (req, res) => {
  const result=DB.prepare("DELETE FROM batbot_messages WHERE id=?").run(Number(req.params.id));
  if(!result.changes)return res.status(404).json({error:"Message introuvable."});
  res.json({message:"Message supprimé avec succès."});
});

app.post("/api/admin/login", (req, res) => {
  const settings = getSettings();
  const phone = cleanPhone(req.body.phone);
  const password = String(req.body.password || "");

  if (
    phone !== cleanPhone(settings.adminPhone) ||
    !bcrypt.compareSync(password, settings.adminPasswordHash)
  ) {
    return res.status(401).json({ error: "Accès administrateur refusé." });
  }

  req.session.admin = true;
  req.session.save((saveError) => {
    if (saveError) {
      console.error("ADMIN SESSION SAVE:", saveError);
      return res.status(500).json({ error: "Session administrateur impossible à enregistrer." });
    }
    res.json({ message: "Administration ouverte." });
  });
});

app.get("/api/admin/me", (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: "Non connecté." });
  res.json({ admin: true });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.admin = false;
  res.json({ message: "Administration déconnectée." });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({
    users: DB.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    analyses: DB.prepare("SELECT COUNT(*) AS n FROM analysis_requests").get().n,
    pending: DB.prepare(
      "SELECT COUNT(*) AS n FROM analysis_requests WHERE status='pending'"
    ).get().n,
    password_resets: DB.prepare(
      "SELECT COUNT(*) AS n FROM password_resets WHERE status='pending'"
    ).get().n
  });
});

app.post("/api/payment-requests", requireUser, (req, res) => {
  const offer = String(req.body.offer || "").trim();
  const operator = String(req.body.operator || "").trim();
  const amount = Number(req.body.amount);
  const reference = String(req.body.reference || "").trim();
  const allowedOperators = ["Orange Money", "MTN Money", "Moov Money", "Wave"];

  if (!offer || !allowedOperators.includes(operator) || !Number.isFinite(amount) || amount <= 0 || !reference) {
    return res.status(400).json({ error: "Veuillez remplir correctement tous les champs du paiement." });
  }
  const result = DB.prepare(
    "INSERT INTO payment_requests(user_id,offer,operator,amount,reference) VALUES(?,?,?,?,?)"
  ).run(req.session.userId, offer, operator, Math.round(amount), reference);
  res.json({ message: "Référence enregistrée. Envoyez maintenant votre preuve sur WhatsApp.", id: result.lastInsertRowid });
});

app.get("/api/payment-requests/mine", requireUser, (req, res) => {
  const requests = DB.prepare(`
    SELECT id, offer, operator, amount, reference, status, admin_note, created_at, resolved_at
    FROM payment_requests
    WHERE user_id=?
    ORDER BY id DESC
  `).all(req.session.userId);
  res.json({ requests });
});

app.get("/api/admin/payment-requests", requireAdmin, (req, res) => {
  const requests = DB.prepare(`
    SELECT p.*, u.username, u.phone
    FROM payment_requests p LEFT JOIN users u ON u.id=p.user_id
    ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END, p.id DESC
  `).all();
  res.json({ requests });
});

app.patch("/api/admin/payment-requests/:id", requireAdmin, (req, res) => {
  const status = String(req.body.status || "").toLowerCase();
  if (!["accepted", "rejected"].includes(status)) return res.status(400).json({ error: "Statut invalide." });
  const request = DB.prepare("SELECT * FROM payment_requests WHERE id=?").get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: "Demande introuvable." });
  if (request.status !== "pending") return res.status(409).json({ error: "Cette demande a déjà été traitée." });

  const resolve = DB.transaction(() => {
    if (status === "accepted" && /premium/i.test(request.offer)) {
      const durationDays = /30\s*j|30\s*jours/i.test(request.offer) ? 30 : 7;
      const now = new Date();
      const user = DB.prepare("SELECT premium_until, ai_until FROM users WHERE id=?").get(request.user_id);
      const currentUntil = user?.premium_until && new Date(user.premium_until) > now ? new Date(user.premium_until) : now;
      const until = new Date(currentUntil.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
      DB.prepare("UPDATE users SET premium_started_at=?, premium_until=? WHERE id=?").run(now.toISOString(), until, request.user_id);
      if (/ia/i.test(request.offer)) DB.prepare("UPDATE users SET ai_started_at=?, ai_until=? WHERE id=?").run(now.toISOString(), until, request.user_id);
    }
    const result = DB.prepare("UPDATE payment_requests SET status=?, resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(status, request.id);
    if (result.changes !== 1) throw new Error("Cette demande a déjà été traitée.");
  });
  try {
    resolve();
    res.json({ message: status === "accepted" ? "Paiement accepté." : "Paiement refusé." });
  } catch (error) {
    res.status(409).json({ error: error.message || "Demande déjà traitée." });
  }
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({
    users: DB.prepare("SELECT * FROM users ORDER BY id DESC").all().map(userView)
  });
});

app.post("/api/admin/subscription", requireAdmin, (req, res) => {
  const id = Number(req.body.user_id);
  const active = Boolean(req.body.active);
  const durationDays = Math.max(1, Math.min(3650, Number(req.body.duration_days) || 7));
  const startedAt = active ? new Date() : null;
  const until = active
    ? new Date(startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const result = DB.prepare(
    "UPDATE users SET premium_started_at=?, premium_until=? WHERE id=?"
  ).run(startedAt ? startedAt.toISOString() : null, until, id);

  if (!result.changes) return res.status(404).json({ error: "Utilisateur introuvable." });
  res.json({ message: active ? `Premium activé pour ${durationDays} jour(s).` : "Premium désactivé." });
});

// Activation de l'accès IA : l'utilisateur doit aussi avoir Premium actif.
app.post("/api/admin/ai-subscription", requireAdmin, (req, res) => {
  const id = Number(req.body.user_id);
  const active = Boolean(req.body.active);
  const durationDays = Math.max(1, Math.min(3650, Number(req.body.duration_days) || 7));
  const user = DB.prepare("SELECT * FROM users WHERE id=?").get(id);

  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

  if (active) {
    const premiumActive = !!(user.premium_until && new Date(user.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(400).json({
        error: "Activez d’abord Premium pour autoriser l’accès à l’IA."
      });
    }
    const until = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    DB.prepare("UPDATE users SET ai_started_at=?, ai_until=? WHERE id=?").run(new Date().toISOString(), until, id);
    return res.json({ message: `IA activée pour ${durationDays} jour(s).`, ai_until: until });
  }

  DB.prepare("UPDATE users SET ai_until=NULL WHERE id=?").run(id);
  res.json({ message: "Accès IA désactivé." });
});

app.patch("/api/admin/users/:id/status", requireAdmin, (req, res) => {
  const disabled = Boolean(req.body.disabled);
  const result = DB.prepare("UPDATE users SET disabled=? WHERE id=?")
    .run(disabled ? 1 : 0, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Utilisateur introuvable." });
  res.json({ message: disabled ? "Compte désactivé." : "Compte réactivé." });
});

app.post("/api/admin/reset-password", requireAdmin, (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 6) {
    return res.status(400).json({ error: "Minimum 6 caractères." });
  }

  const result = DB.prepare(`
    UPDATE users
    SET password_hash=?, must_change_password=0, temporary_password_hash=NULL, temporary_password_expires_at=NULL
    WHERE id=?
  `).run(bcrypt.hashSync(password, 12), Number(req.body.user_id));

  if (!result.changes) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({ message: "Mot de passe modifié avec succès." });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const result = DB.prepare(
    "DELETE FROM users WHERE id=?"
  ).run(Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({ message: "Membre supprimé." });
});

app.get("/api/admin/password-resets", requireAdmin, (req, res) => {
  res.json({
    requests: DB.prepare(`
      SELECT pr.*, u.username, u.phone
      FROM password_resets pr
      JOIN users u ON u.id=pr.user_id
      WHERE pr.status='pending'
      ORDER BY pr.id DESC
    `).all()
  });
});

// Alias utilisé par l'interface actuelle.
app.get("/api/admin/reset-requests", requireAdmin, (req, res) => {
  res.json({
    requests: DB.prepare(`
      SELECT pr.*, u.username, u.phone
      FROM password_resets pr
      JOIN users u ON u.id=pr.user_id
      WHERE pr.status='pending'
      ORDER BY pr.id DESC
    `).all()
  });
});

app.post("/api/admin/reset-requests/:id/resolve", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const request = DB.prepare(`
    SELECT pr.id, pr.user_id, pr.status, pr.delivery_token, u.username, u.disabled
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.id=?
  `).get(id);

  if (!request) return res.status(404).json({ error: "Demande introuvable." });
  if (request.status !== "pending") return res.status(409).json({ error: "Cette demande a déjà été traitée." });
  if (request.disabled) return res.status(409).json({ error: "Ce compte est désactivé." });

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let temporaryPassword = "BBOT-";
  const bytes = crypto.randomBytes(8);
  for (const byte of bytes) temporaryPassword += alphabet[byte % alphabet.length];

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const transaction = DB.transaction(() => {
    DB.prepare(`
      UPDATE users
      SET temporary_password_hash=?, temporary_password_expires_at=?, must_change_password=1
      WHERE id=?
    `).run(bcrypt.hashSync(temporaryPassword, 12), expiresAt, request.user_id);

    DB.prepare(`
      UPDATE password_resets
      SET status='resolved', temporary_password_encrypted=?, temporary_password_expires_at=?, resolved_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'
    `).run(encryptTemporaryPassword(temporaryPassword), expiresAt, id);
  });

  transaction();

  res.json({
    message: `Nouveau mot de passe temporaire généré pour ${request.username}.`,
    username: request.username,
    new_password: temporaryPassword,
    expires_at: expiresAt,
    request_token: request.delivery_token
  });
});

app.patch("/api/admin/password-resets/:id", requireAdmin, (req, res) => {
  const status = req.body.status === "resolved" ? "resolved" : "pending";
  DB.prepare(
    "UPDATE password_resets SET status=? WHERE id=?"
  ).run(status, Number(req.params.id));
  res.json({ message: "Demande traitée." });
});

app.get("/api/admin/requests", requireAdmin, (req, res) => {
  res.json({
    requests: DB.prepare(`
      SELECT ar.*, u.username, u.phone
      FROM analysis_requests ar
      LEFT JOIN users u ON u.id=ar.user_id
      ORDER BY ar.id DESC
    `).all()
  });
});

app.patch("/api/admin/requests/:id", requireAdmin, (req, res) => {
  const allowed = ["pending", "processing", "completed", "cancelled"];
  const status = allowed.includes(req.body.status)
    ? req.body.status
    : "pending";

  DB.prepare(
    "UPDATE analysis_requests SET status=? WHERE id=?"
  ).run(status, Number(req.params.id));

  res.json({ message: "Demande mise à jour." });
});

// ======================================================
// VALIDATION DES ÉQUIPES + TEMPS RÉEL DES PRONOSTICS
// ======================================================
const footballTeamCache = new Map();
const memberPredictionClients = new Set();
const MEMBER_PREDICTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupExpiredMemberPredictions(notify = true) {
  const result = DB.prepare("DELETE FROM member_predictions WHERE created_at <= datetime('now','-24 hours')").run();
  if (result.changes && notify) broadcastMemberPredictionEvent({ type: "expired", count: result.changes });
  return result.changes;
}

function broadcastMemberPredictionEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of memberPredictionClients) {
    try { client.write(data); } catch (_) { memberPredictionClients.delete(client); }
  }
}

async function validateFootballTeamForAI(teamName) {
  const name = String(teamName || '').trim();
  if (!name) return false;

  // Priorité au catalogue local BATBOT : les noms déjà reconnus localement
  // ne dépendent pas d'un résultat de recherche API-Football. Cela évite les
  // faux refus sur les variantes connues (ex. Côte d'Ivoire, FC Barcelona, etc.).
  if (validateLocalFootballTeam(name)) return true;

  // Pour les équipes absentes du catalogue local, on conserve la vérification
  // API-Football afin de permettre une couverture plus large sans accepter des
  // noms inventés.
  if (!API_FOOTBALL_KEY) return null;

  const cacheKey = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const cached = footballTeamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;
  try {
    const data = await callApiFootball('teams', { search: name });
    const valid = Array.isArray(data.response) && data.response.length > 0;
    footballTeamCache.set(cacheKey, { valid, expiresAt: Date.now() + 15 * 60 * 1000 });
    return valid;
  } catch (error) {
    console.error('TEAM VALIDATION IA:', error.message);
    return null;
  }
}

app.get('/api/member-predictions/stream', requireUser, (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`retry: 1500\n\n`);
  const client = res;
  memberPredictionClients.add(client);
  const keepAlive = setInterval(() => { try { client.write(': keep-alive\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(keepAlive); memberPredictionClients.delete(client); });
});

setInterval(() => cleanupExpiredMemberPredictions(true), 60 * 1000);

// Catalogue local des équipes reconnues par les publications de membres.
// IMPORTANT : ce catalogue est volontairement local : aucune requête API-Football
// n'est effectuée lors de la publication d'un pronostic membre.
// API-Football reste réservé aux fonctions qui utilisent explicitement l'IA/Matchs du jour.
const FOOTBALL_TEAMS_FILE = path.join(__dirname, "data", "football-teams.json");
let LOCAL_FOOTBALL_TEAMS;
try {
  LOCAL_FOOTBALL_TEAMS = JSON.parse(require("fs").readFileSync(FOOTBALL_TEAMS_FILE, "utf8"));
  if (!Array.isArray(LOCAL_FOOTBALL_TEAMS) || LOCAL_FOOTBALL_TEAMS.length === 0) {
    throw new Error("Le catalogue local des équipes est vide ou invalide.");
  }
  LOCAL_FOOTBALL_TEAMS = LOCAL_FOOTBALL_TEAMS
    .filter(team => typeof team === "string" && team.trim())
    .map(team => team.trim());
} catch (error) {
  console.error("CATALOGUE ÉQUIPES LOCALES:", error.message);
  throw new Error("Impossible de charger data/football-teams.json. Le serveur ne peut pas démarrer sans son catalogue local.");
}

function normalizeFootballTeamName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|bk|fk|sk|nk|ks|kfc|pfc|cd|cs|as|rc|rsc|sv|kv|ka|fk|club|football club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LOCAL_FOOTBALL_TEAM_SET = new Set(
  LOCAL_FOOTBALL_TEAMS.map(normalizeFootballTeamName).filter(Boolean)
);

function validateLocalFootballTeam(teamName) {
  const normalized = normalizeFootballTeamName(teamName);
  if (!normalized || normalized.length < 2) return false;
  return LOCAL_FOOTBALL_TEAM_SET.has(normalized);
}

const FOOTBALL_ANALYSIS_TERMS = [
  "victoire", "gagner", "gagnant", "nul", "defaite", "perdre", "perd",
  "buts", "but", "score", "mi temps", "premiere mi temps", "seconde mi temps",
  "forme", "forme actuelle", "attaque", "defense", "defensive", "offensive",
  "domicile", "exterieur", "classement", "statistique", "statistiques",
  "probabilite", "probabilites", "pronostic", "analyse", "match", "rencontre",
  "carton", "cartons", "corner", "corners", "btts", "over", "under",
  "plus de", "moins de", "handicap", "cote", "cotes", "confiance",
  "historique", "face a face", "h2h", "joueur", "effectif", "blessure",
  "absent", "absents", "titulaire", "titulaires", "composition", "terrain"
];

const BANNED_COMMENT_TERMS = [
  "bonjour", "bonsoir", "salut", "cc", "coucou", "hello", "yo",
  "insulte", "idiot", "imbecile", "connard", "pute", "putain",
  "merde", "encule", "enculé", "batard", "bâtard", "nique", "fuck",
  "spam", "test test", "lorem ipsum"
];

const BANNED_ANALYSIS_ABBREVIATIONS = new Set([
  "mdr", "ptdr", "lol", "bjr", "bsr", "svp", "stp", "wsh", "wshh",
  "asl", "irl", "omg", "wtf", "idk", "tg"
]);

function validateMemberPredictionComment(comment, homeTeam, awayTeam) {
  const value = String(comment || "").trim();
  if (!value) return { valid: true };

  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (value.length < 12) {
    return { valid: false, error: "La description doit contenir une véritable explication de l'analyse du match." };
  }

  if (/[<>]/.test(value) || /https?:\/\/|www\./i.test(value)) {
    return { valid: false, error: "Les liens et contenus techniques ne sont pas autorisés dans la description." };
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.some(word => BANNED_ANALYSIS_ABBREVIATIONS.has(word.replace(/[^\w]/g, "")))) {
    return { valid: false, error: "Les abréviations et messages de type chat ne sont pas autorisés dans la description." };
  }

  const normalizedWords = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const hasBannedWord = BANNED_COMMENT_TERMS.some(term => {
    if (term.includes(" ")) return normalized.includes(term);
    return normalizedWords.includes(term);
  });
  if (hasBannedWord) {
    return { valid: false, error: "La description contient un terme interdit ou un contenu qui n'est pas adapté à l'analyse football." };
  }

  const footballContext = FOOTBALL_ANALYSIS_TERMS.some(term => normalized.includes(term));
  const hasTeamContext =
    normalized.includes(normalizeFootballTeamName(homeTeam)) ||
    normalized.includes(normalizeFootballTeamName(awayTeam));

  if (!footballContext && !hasTeamContext) {
    return { valid: false, error: "La description doit être directement liée à l'analyse du match et aux équipes sélectionnées." };
  }

  if ((value.match(/[!?]{3,}/g) || []).length > 0 || (value.match(/(.)\1{6,}/g) || []).length > 0) {
    return { valid: false, error: "Évitez le spam, les répétitions et les caractères excessifs dans la description." };
  }

  return { valid: true };
}

function findActiveCoupon(code, bookmaker) {
  if (!code) return null;
  const normalizedCode = code.trim().toLowerCase();
  const coupons = DB.prepare(
    "SELECT id,platform_name,code,platform_url,description FROM coupons WHERE active=1"
  ).all();

  const match = coupons.find(c =>
    String(c.code || "").trim().toLowerCase() === normalizedCode &&
    (!bookmaker || String(c.platform_name || "").trim().toLowerCase() === bookmaker.trim().toLowerCase())
  );
  return match || null;
}

// ======================================================
// PRONOSTICS DES MEMBRES
// ======================================================
app.get("/api/member-predictions", requireUser, (req, res) => {
  cleanupExpiredMemberPredictions(false);
  const predictions = DB.prepare(`
    SELECT p.id,p.user_id,u.username,p.home_team,p.away_team,
           p.home_probability,p.draw_probability,p.away_probability,
           p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
    FROM member_predictions p
    JOIN users u ON u.id=p.user_id
    WHERE u.disabled=0
      AND p.created_at > datetime('now','-24 hours')
    ORDER BY p.id DESC
    LIMIT 100
  `).all();
  res.json({ predictions });
});

app.post("/api/member-predictions", requireUser, (req, res) => {
  const homeTeam = String(req.body.home_team || "").trim();
  const awayTeam = String(req.body.away_team || "").trim();
  const prediction = String(req.body.prediction || "").trim();
  const couponCode = String(req.body.coupon_code || "").trim();
  const bookmaker = String(req.body.bookmaker || "").trim();
  const comment = String(req.body.comment || "").trim();

  const homeProbability = Number(req.body.home_probability);
  const drawProbability = Number(req.body.draw_probability);
  const awayProbability = Number(req.body.away_probability);

  if (!homeTeam || !awayTeam || !prediction) {
    return res.status(400).json({ error: "Les deux équipes et le pronostic sont obligatoires." });
  }

  cleanupExpiredMemberPredictions(false);
  const recent = DB.prepare("SELECT id FROM member_predictions WHERE user_id=? AND created_at > datetime('now','-24 hours') LIMIT 1").get(req.session.userId);
  if (recent) {
    return res.status(409).json({ error: "Vous avez déjà publié un pronostic au cours des dernières 24 heures. Vous pourrez en publier un nouveau après ce délai." });
  }

  const homeValid = validateLocalFootballTeam(homeTeam);
  const awayValid = validateLocalFootballTeam(awayTeam);
  if (!homeValid || !awayValid) {
    return res.status(400).json({
      error: "Les deux noms doivent correspondre à des équipes de football reconnues dans le catalogue local de BatBot."
    });
  }

  if (
    homeTeam.length > 80 || awayTeam.length > 80 ||
    prediction.length > 120 || couponCode.length > 120 ||
    bookmaker.length > 80 || comment.length > 500
  ) {
    return res.status(400).json({ error: "Un ou plusieurs champs sont trop longs." });
  }

  if (
    ![homeProbability, drawProbability, awayProbability].every(Number.isFinite) ||
    homeProbability < 0 || homeProbability > 100 ||
    drawProbability < 0 || drawProbability > 100 ||
    awayProbability < 0 || awayProbability > 100 ||
    Math.abs(homeProbability + drawProbability + awayProbability - 100) > 0.01
  ) {
    return res.status(400).json({
      error: "Les probabilités doivent être comprises entre 0 et 100% et totaliser exactement 100%."
    });
  }

  if (couponCode && !bookmaker) {
    return res.status(400).json({
      error: "Indiquez le site ou bookmaker correspondant au code coupon."
    });
  }

  const commentValidation = validateMemberPredictionComment(comment, homeTeam, awayTeam);
  if (!commentValidation.valid) {
    return res.status(400).json({ error: commentValidation.error });
  }

  if (couponCode) {
    const coupon = findActiveCoupon(couponCode, bookmaker);
    if (!coupon) {
      return res.status(400).json({
        error: "Le code coupon indiqué n'est pas un coupon actif enregistré dans BatBot pour ce bookmaker."
      });
    }
  }

  const result = DB.prepare(`
    INSERT INTO member_predictions(
      user_id,home_team,away_team,home_probability,draw_probability,
      away_probability,prediction,coupon_code,bookmaker,comment
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.session.userId,homeTeam,awayTeam,homeProbability,drawProbability,
    awayProbability,prediction,couponCode,bookmaker,comment
  );

  const created = DB.prepare(`
    SELECT p.id,p.user_id,u.username,p.home_team,p.away_team,
           p.home_probability,p.draw_probability,p.away_probability,
           p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
    FROM member_predictions p
    JOIN users u ON u.id=p.user_id
    WHERE p.id=?
  `).get(Number(result.lastInsertRowid));

  broadcastMemberPredictionEvent({ type: "created", prediction: created });
  res.status(201).json({
    message: "Pronostic publié avec succès.",
    prediction: created
  });
});

app.get("/api/admin/member-predictions", requireAdmin, (req, res) => {
  const predictions = DB.prepare(`
    SELECT p.id,p.user_id,u.username,u.disabled,p.home_team,p.away_team,
           p.home_probability,p.draw_probability,p.away_probability,
           p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
    FROM member_predictions p
    JOIN users u ON u.id=p.user_id
    ORDER BY p.id DESC
  `).all();
  res.json({ predictions });
});

app.delete("/api/admin/member-predictions/:id", requireAdmin, (req, res) => {
  const result = DB.prepare(
    "DELETE FROM member_predictions WHERE id=?"
  ).run(Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({ error: "Pronostic introuvable." });
  }

  broadcastMemberPredictionEvent({ type: "deleted", id: Number(req.params.id) });
  res.json({ message: "Pronostic supprimé avec succès." });
});

app.post("/api/admin/daily-matches", requireAdmin, (req, res) => {
  const name = String(req.body.match_name || "").trim();
  const pick = String(req.body.recommended_pick || "").trim();
  const h = Number(req.body.home_probability);
  const d = Number(req.body.draw_probability);
  const a = Number(req.body.away_probability);
  const odds = req.body.odds === "" || req.body.odds === undefined
    ? null
    : Number(req.body.odds);

  if (
    !name || !pick ||
    ![h, d, a].every(Number.isFinite) ||
    h < 0 || h > 100 ||
    d < 0 || d > 100 ||
    a < 0 || a > 100 ||
    Math.abs(h + d + a - 100) > 0.01
  ) {
    return res.status(400).json({
      error: "Probabilités invalides : elles doivent totaliser 100%."
    });
  }

  if (odds !== null && (!Number.isFinite(odds) || odds < 1)) {
    return res.status(400).json({ error: "Cote invalide." });
  }

  DB.prepare(`
    INSERT INTO daily_matches(
      match_name, home_probability, draw_probability,
      away_probability, recommended_pick, odds, match_date
    ) VALUES(?,?,?,?,?,?,?)
  `).run(name, h, d, a, pick, odds, today());

  res.status(201).json({ message: "Match ajouté avec succès." });
});

app.get("/api/admin/daily-matches", requireAdmin, (req, res) => {
  res.json({
    matches: DB.prepare(
      "SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC"
    ).all(today())
  });
});

app.delete("/api/admin/daily-matches/:id", requireAdmin, (req, res) => {
  DB.prepare(
    "DELETE FROM daily_matches WHERE id=?"
  ).run(Number(req.params.id));
  res.json({ message: "Match supprimé." });
});

function validHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return ["http:", "https:"].includes(u.protocol);
  } catch (_) {
    return false;
  }
}

// Initialisation des bookmakers existants, une seule fois.
if (DB.prepare("SELECT COUNT(*) AS n FROM bookmakers").get().n === 0) {
  const seed = [
    ["1WIN", "500%", "https://1wyvrz.life/?p=gc9k"],
    ["PARIPESA", "500%", "https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651"],
    ["AFROPARI", "300%", "https://apaff.top/L?tag=d_3763651m_70055c_&site=3763651&ad=70055"],
    ["MELBET", "200%", "https://refpa3665.com/L?tag=d_4685320m_66335c_&site=4685320&ad=663"],
    ["LOTO", "", "https://jdnlotto.com/register?promo=123"]
  ];
  const insert = DB.prepare("INSERT INTO bookmakers(name,bonus,url) VALUES(?,?,?)");
  const seedMany = DB.transaction(rows => rows.forEach(row => insert.run(...row)));
  seedMany(seed);
}

app.get("/api/config", (req, res) => {
  const s = getSettings();
  res.json({
    whatsapp: s.whatsapp, telegram: s.telegram,
    whatsappGroup: s.whatsappGroup, telegramGroup: s.telegramGroup,
    tiktok: s.tiktok, facebook: s.facebook, instagram: s.instagram,
    wave500: s.wave500, wave1000: s.wave1000, wavePromo: s.wavePromo,
    promoFee: s.promoFee,
    sdriveLink: s.sdriveLink || "", sdriveInviteMessage: s.sdriveInviteMessage || "",
    bookmakers: DB.prepare("SELECT id,name,bonus,url FROM bookmakers WHERE active=1 ORDER BY id DESC").all()
  });
});

app.get("/api/payment-number", requireUser, (req, res) => {
  const operator = String(req.query.operator || "").trim();
  const keyByOperator = {
    "Orange Money": "orangeMoney",
    "MTN Money": "mtnMoney",
    "Moov Money": "moovMoney"
  };
  const key = keyByOperator[operator];
  if (!key) return res.status(400).json({ error: "Opérateur de paiement invalide." });
  const settings = getSettings();
  const number = cleanPhone(settings[key]);
  if (!number) return res.status(404).json({ error: "Numéro de dépôt indisponible pour cet opérateur." });
  res.set("Cache-Control","no-store");
  res.json({ number });
});

app.get("/api/coupons", requireUser, (req, res) => {
  res.json({ coupons: DB.prepare(
    "SELECT id,platform_name,code,platform_url,description FROM coupons WHERE active=1 ORDER BY id DESC"
  ).all() });
});

app.get("/api/admin/bookmakers", requireAdmin, (req, res) => {
  res.json({ bookmakers: DB.prepare("SELECT * FROM bookmakers ORDER BY id DESC").all() });
});

app.post("/api/admin/bookmakers", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const bonus = String(req.body.bonus || "").trim();
  const url = String(req.body.url || "").trim();
  if (!name || !validHttpUrl(url)) return res.status(400).json({ error: "Nom et lien HTTP/HTTPS valides requis." });
  const result = DB.prepare("INSERT INTO bookmakers(name,bonus,url,active) VALUES(?,?,?,?)")
    .run(name, bonus, url, req.body.active === false ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid, message: "Bookmaker ajouté." });
});

app.patch("/api/admin/bookmakers/:id", requireAdmin, (req, res) => {
  const current = DB.prepare("SELECT * FROM bookmakers WHERE id=?").get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: "Bookmaker introuvable." });
  const name = String(req.body.name ?? current.name).trim();
  const bonus = String(req.body.bonus ?? current.bonus).trim();
  const url = String(req.body.url ?? current.url).trim();
  if (!name || !validHttpUrl(url)) return res.status(400).json({ error: "Nom et lien valides requis." });
  DB.prepare("UPDATE bookmakers SET name=?,bonus=?,url=?,active=? WHERE id=?")
    .run(name, bonus, url, req.body.active === undefined ? current.active : (req.body.active ? 1 : 0), current.id);
  res.json({ message: "Bookmaker modifié." });
});

app.delete("/api/admin/bookmakers/:id", requireAdmin, (req, res) => {
  DB.prepare("DELETE FROM bookmakers WHERE id=?").run(Number(req.params.id));
  res.json({ message: "Bookmaker supprimé." });
});

app.get("/api/admin/coupons", requireAdmin, (req, res) => {
  res.json({ coupons: DB.prepare("SELECT * FROM coupons ORDER BY id DESC").all() });
});

app.post("/api/admin/coupons", requireAdmin, (req, res) => {
  const platformName = String(req.body.platform_name || "").trim();
  const code = String(req.body.code || "").trim();
  const platformUrl = String(req.body.platform_url || "").trim();
  const description = String(req.body.description || "").trim();
  if (!platformName || !code || !validHttpUrl(platformUrl)) {
    return res.status(400).json({ error: "Plateforme, code et lien valides requis." });
  }
  const result = DB.prepare(
    "INSERT INTO coupons(platform_name,code,platform_url,description,active) VALUES(?,?,?,?,?)"
  ).run(platformName, code, platformUrl, description, req.body.active === false ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid, message: "Coupon ajouté." });
});

app.patch("/api/admin/coupons/:id", requireAdmin, (req, res) => {
  const c = DB.prepare("SELECT * FROM coupons WHERE id=?").get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Coupon introuvable." });
  const data = {
    platform_name: String(req.body.platform_name ?? c.platform_name).trim(),
    code: String(req.body.code ?? c.code).trim(),
    platform_url: String(req.body.platform_url ?? c.platform_url).trim(),
    description: String(req.body.description ?? c.description).trim(),
    active: req.body.active === undefined ? c.active : (req.body.active ? 1 : 0)
  };
  if (!data.platform_name || !data.code || !validHttpUrl(data.platform_url)) {
    return res.status(400).json({ error: "Données de coupon invalides." });
  }
  DB.prepare("UPDATE coupons SET platform_name=?,code=?,platform_url=?,description=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(data.platform_name, data.code, data.platform_url, data.description, data.active, c.id);
  res.json({ message: "Coupon modifié." });
});

app.delete("/api/admin/coupons/:id", requireAdmin, (req, res) => {
  DB.prepare("DELETE FROM coupons WHERE id=?").run(Number(req.params.id));
  res.json({ message: "Coupon supprimé." });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const s = getSettings(); delete s.adminPasswordHash;
  res.json({ settings: s });
});

app.patch("/api/admin/settings", requireAdmin, (req, res) => {
  const allowed = [
    "whatsapp", "telegram", "whatsappGroup", "telegramGroup",
    "tiktok", "facebook", "instagram", "wave500", "wave1000",
    "wavePromo", "promoFee", "orangeMoney", "moovMoney", "mtnMoney",
    "adminPhone", "sdriveLink", "sdriveInviteMessage"
  ];
  for (const key of allowed) if (req.body[key] !== undefined) setSetting.run(key, String(req.body[key]));
  const settings = getSettings(); delete settings.adminPasswordHash;
  res.json({ message: "Configuration enregistrée.", settings });
});


app.post("/api/ai/analyze", requireUser, async (req, res) => {
  const user = DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  const premiumActive = !!(user && user.premium_until && new Date(user.premium_until) > new Date());
  const aiActive = !!(user && user.ai_until && new Date(user.ai_until) > new Date());
  if (!premiumActive || !aiActive) {
    return res.status(403).json({
      error: "L’accès à BatBot IA nécessite un abonnement Premium et une autorisation IA active."
    });
  }

  const home = String(req.body.home_team || "").trim();
  const away = String(req.body.away_team || "").trim();
  const secondHome = String(req.body.second_home_team || "").trim();
  const secondAway = String(req.body.second_away_team || "").trim();

  if (!home && !away && !secondHome && !secondAway) {
    return res.status(400).json({ error: "Saisissez au moins un match au format : Équipe 1 vs Équipe 2." });
  }
  if ((home && !away) || (!home && away) || (secondHome && !secondAway) || (!secondHome && secondAway)) {
    return res.status(400).json({ error: "Chaque match renseigné doit contenir deux équipes : Équipe 1 vs Équipe 2." });
  }

  const rawMatches = [[home, away], [secondHome, secondAway]].filter(([h, a]) => h && a);
  const validation = await Promise.all(rawMatches.flatMap(([h, a]) => [validateFootballTeamForAI(h), validateFootballTeamForAI(a)]));
  if (validation.some(value => value === null)) {
    return res.status(503).json({ error: "La vérification des équipes est temporairement indisponible. Réessayez dans quelques instants." });
  }
  if (validation.some(value => value === false)) {
    return res.status(400).json({ error: "L’analyse accepte uniquement des équipes de football reconnues. Vérifiez les noms saisis." });
  }

  const matches = rawMatches.map(([h, a], index) => `${index + 1}) ${h} vs ${a}`);
  const matchCount = matches.length;
  const combinedInstruction = matchCount > 1
    ? 'Si deux matchs sont fournis, retourne aussi combined avec :\n- selections : les deux choix retenus, très courts ;\n- estimated_odds : une cote combinée estimée, par exemple "2.00 à 3.00".'
    : 'Si un seul match est fourni, ne retourne pas combined.';
  const combinedStructure = matchCount > 1
    ? ',\n  "combined": {\n    "selections":"...",\n    "estimated_odds":"..."\n  }'
    : '';
  const prompt = `Tu es BatBot IA, assistant d’analyse football. Réponds uniquement avec un JSON valide, sans introduction, sans Markdown et sans texte supplémentaire.

Matchs à analyser :
${matches.join("\n")}

Objectif : fournir une fiche courte, claire et directement lisible sur téléphone.
Pour chacun des ${matchCount} match${matchCount > 1 ? 's' : ''}, retourne :
- name : nom du match ;
- probabilities : 3 à 5 probabilités courtes parmi 1, X, 2, double chance, buts ;
- options : 4 à 6 options pertinentes parmi 1X, X2, 12, victoire, plus/moins de buts, BTTS, handicap et score exact. Pour chaque option, indique name, probability et risk en quelques mots ;
- recommendation : une seule option principale.

${combinedInstruction}
N’invente pas de statistiques, de blessures, de résultats ou de cotes en direct. Ne donne aucune longue explication. Utilise exactement cette structure :
{
  "matches": [
    {
      "name": "...",
      "probabilities": [{"label":"1","value":"..."},{"label":"X","value":"..."},{"label":"2","value":"..."}],
      "options": [{"name":"...","probability":"...","risk":"..."}],
      "recommendation":"..."
    }
  ]${combinedStructure}
}`;

  const systemInstruction = "Retourne uniquement le JSON demandé en français. Sois bref, organisé et ne fabrique aucune donnée précise non fournie.";

  try {
    let analysis = "";

    if (process.env.GROQ_API_KEY) {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          temperature: 0.2,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
          ]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Groq provider error:", response.status, data?.error?.message || "unknown");
        return res.status(502).json({ error: "Le service Groq est temporairement indisponible." });
      }
      analysis = data?.choices?.[0]?.message?.content?.trim() || "";
    } else if (process.env.OPENAI_API_KEY) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt }
          ]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("OpenAI provider error:", response.status, data?.error?.message || "unknown");
        return res.status(502).json({ error: "Le service IA est temporairement indisponible." });
      }
      analysis = data?.choices?.[0]?.message?.content?.trim() || "";
    } else {
      return res.status(503).json({
        error: "BatBot IA est temporairement indisponible. Configurez GROQ_API_KEY ou OPENAI_API_KEY."
      });
    }

    if (!analysis) return res.status(502).json({ error: "BatBot IA n’a pas retourné de résultat." });
    res.json({ analysis, provider: process.env.GROQ_API_KEY ? "groq" : "openai" });
  } catch (error) {
    console.error("AI request error:", error.message);
    res.status(502).json({ error: "BatBot IA est temporairement indisponible." });
  }
});


// ===== API-FOOTBALL (lecture seule, sans modifier les fonctionnalités existantes) =====
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || process.env.APIFOOTBALL_KEY;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

async function callApiFootball(endpoint, params = {}) {
  if (!API_FOOTBALL_KEY) {
    const error = new Error("Variable API_FOOTBALL_KEY absente");
    error.status = 503;
    throw error;
  }

  const url = new URL(`${API_FOOTBALL_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { "x-apisports-key": API_FOOTBALL_KEY }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || (Array.isArray(data.errors) && data.errors.length > 0)) {
    const message = Array.isArray(data.errors)
      ? data.errors.join(", ")
      : `API-Football HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status || 502;
    throw error;
  }

  return data;
}

// Liste des matchs : endpoint indépendant, sans toucher à /api/ai/analyze.
app.get("/api/football/fixtures", requireUser, async (req, res) => {
  try {
    const allowed = ["date", "from", "to", "league", "season", "team", "next", "last", "live", "timezone"];
    const params = {};
    for (const key of allowed) {
      if (req.query[key] !== undefined) params[key] = req.query[key];
    }

    const currentUser = DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
    const premiumActive = !!(currentUser && currentUser.premium_until && new Date(currentUser.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(403).json({
        ok: false,
        error: "Un abonnement Premium actif est nécessaire pour accéder aux matchs API-Football."
      });
    }

    const hasDateFilter = params.date || params.from || params.to || params.live || params.next || params.last;
    if (!hasDateFilter) {
      params.date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Abidjan",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
      params.timezone = params.timezone || "Africa/Abidjan";
    }

    const data = await callApiFootball("fixtures", params);
    res.json({ ok: true, source: "api-football", ...data });
  } catch (error) {
    console.error("API-Football fixtures:", error.message);
    res.status(error.status || 502).json({
      ok: false,
      error: "Impossible de récupérer les matchs API-Football.",
      details: error.message
    });
  }
});

// Matchs en direct : endpoint indépendant.
app.get("/api/football/live", requireUser, async (req, res) => {
  try {
    const currentUser = DB.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
    const premiumActive = !!(currentUser && currentUser.premium_until && new Date(currentUser.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(403).json({
        ok: false,
        error: "Un abonnement Premium actif est nécessaire pour accéder aux matchs en direct."
      });
    }

    const data = await callApiFootball("fixtures", {
      live: req.query.league || "all",
      timezone: "Africa/Abidjan"
    });
    res.json({ ok: true, source: "api-football", ...data });
  } catch (error) {
    console.error("API-Football live:", error.message);
    res.status(error.status || 502).json({
      ok: false,
      error: "Impossible de récupérer les matchs en direct API-Football.",
      details: error.message
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BatBot démarré sur le port ${PORT}`);
});
