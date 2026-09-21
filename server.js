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
`);

// Migrations pour les bases déjà existantes
try { DB.prepare("ALTER TABLE users ADD COLUMN premium_started_at TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN ai_until TEXT").run(); } catch (_) {}
try { DB.prepare("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0").run(); } catch (_) {}

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
    ai_active: aiActive && active && !Boolean(user.disabled),
    disabled: Boolean(user.disabled),
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

  if (!user || user.disabled || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Identifiants incorrects ou compte désactivé." });
  }

  req.session.userId = user.id;
  res.json({ message: "Connexion réussie.", user: userView(user) });
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
  const user = DB.prepare(
    "SELECT id FROM users WHERE username=?"
  ).get(username);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable avec ces informations."
    });
  }

  DB.prepare("INSERT INTO password_resets(user_id) VALUES(?)").run(user.id);
  res.json({ message: "Demande envoyée à l'administration." });
});

// Compatibilité avec les anciennes versions de l'interface.
app.post("/api/forgot-password", (req, res) => {
  const username = String(req.body.username || "").trim();
  const user = DB.prepare("SELECT id FROM users WHERE username=?").get(username);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable avec ces informations."
    });
  }

  const existing = DB.prepare(
    "SELECT id FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (!existing) {
    DB.prepare("INSERT INTO password_resets(user_id) VALUES(?)").run(user.id);
  }

  res.json({ message: "Demande envoyée à l'administration." });
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
    DB.prepare("UPDATE users SET ai_until=? WHERE id=?").run(until, id);
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

  const result = DB.prepare(
    "UPDATE users SET password_hash=? WHERE id=?"
  ).run(bcrypt.hashSync(password, 12), Number(req.body.user_id));

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
    SELECT pr.id, pr.user_id, pr.status, u.username
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.id=?
  `).get(id);

  if (!request) {
    return res.status(404).json({ error: "Demande introuvable." });
  }

  if (request.status !== "pending") {
    return res.status(409).json({ error: "Cette demande a déjà été traitée." });
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let temporaryPassword = "SD-";
  const bytes = crypto.randomBytes(8);
  for (const byte of bytes) {
    temporaryPassword += alphabet[byte % alphabet.length];
  }

  const transaction = DB.transaction(() => {
    DB.prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(bcrypt.hashSync(temporaryPassword, 12), request.user_id);
    DB.prepare("UPDATE password_resets SET status='resolved' WHERE id=?")
      .run(id);
  });

  transaction();

  res.json({
    message: `Nouveau mot de passe généré pour ${request.username}.`,
    username: request.username,
    new_password: temporaryPassword
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
    promoFee: s.promoFee, orangeMoney: s.orangeMoney,
    moovMoney: s.moovMoney, mtnMoney: s.mtnMoney,
    sdriveLink: s.sdriveLink || "", sdriveInviteMessage: s.sdriveInviteMessage || "",
    bookmakers: DB.prepare("SELECT id,name,bonus,url FROM bookmakers WHERE active=1 ORDER BY id DESC").all()
  });
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
  const context = String(req.body.context || "").trim();

  if (!home || !away) return res.status(400).json({ error: "Les deux équipes du premier match sont requises." });
  if ((secondHome && !secondAway) || (!secondHome && secondAway)) {
    return res.status(400).json({ error: "Complétez les deux équipes du deuxième match ou laissez-les vides." });
  }

  const matches = [`1) ${home} vs ${away}`];
  if (secondHome && secondAway) matches.push(`2) ${secondHome} vs ${secondAway}`);

  const prompt = `Tu es BatBot IA, assistant d’analyse football. Réponds en français, de manière claire,
structurée et prudente, sans garantie de résultat.

Matchs à analyser :
${matches.join("\n")}

Contexte fourni : ${context || "Non fourni"}

Pour chaque match, présente :
- les informations manquantes et les facteurs à vérifier ;
- des probabilités prudentes 1X2, clairement présentées comme des estimations ;
- des marchés possibles : 1X2, double chance, buts, BTTS et handicap ;
- le niveau de risque et les raisons ;
- aucune sélection certaine et aucune donnée en temps réel inventée.

À la fin, propose uniquement, si les informations disponibles le permettent, une combinaison
indicative pour les deux matchs, avec une cote totale explicitement estimée et non garantie.
Précise que les cotes réelles doivent être vérifiées chez un opérateur.
Termine par : « BatBot IA vous conseille de jouer avec beaucoup de modération. »`;

  const systemInstruction = "Tu fournis une analyse informative et prudente. Ne présente jamais une sélection comme certaine. N’invente pas de statistiques, de blessures, de cotes en direct ou de résultats.";

  try {
    let analysis = "";

    if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Gemini provider error:", response.status, data?.error?.message || "unknown");
        return res.status(502).json({ error: "Le service Gemini est temporairement indisponible." });
      }
      analysis = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
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
        error: "BatBot IA est temporairement indisponible. Configurez GEMINI_API_KEY ou OPENAI_API_KEY."
      });
    }

    if (!analysis) return res.status(502).json({ error: "BatBot IA n’a pas retourné de résultat." });
    res.json({ analysis, provider: process.env.GEMINI_API_KEY ? "gemini" : "openai" });
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
app.get("/api/football/fixtures", async (req, res) => {
  try {
    const allowed = ["date", "from", "to", "league", "season", "team", "next", "last", "live", "timezone"];
    const params = {};
    for (const key of allowed) {
      if (req.query[key] !== undefined) params[key] = req.query[key];
    }

    if (Object.keys(params).length === 0) {
      params.date = new Date().toISOString().slice(0, 10);
      params.timezone = "Africa/Abidjan";
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
app.get("/api/football/live", async (req, res) => {
  try {
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
