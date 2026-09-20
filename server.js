const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const AI_TIMEOUT_MS = 25000;

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
  const oldNumber = "2250152171774";
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
  return {
    id: user.id,
    username: user.username,
    name: user.username,
    phone: user.phone,
    premium_until: user.premium_until,
    premium_started_at: user.premium_started_at || null,
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
  const active = !!(user && user.premium_until && new Date(user.premium_until) > new Date());
  if (!active) return res.status(403).json({ error: "L’accès à BatBot IA nécessite un abonnement actif." });

  const home = String(req.body.home_team || "").trim();
  const away = String(req.body.away_team || "").trim();
  const context = String(req.body.context || "").trim();
  if (!home || !away) return res.status(400).json({ error: "Les deux équipes sont requises." });

  const prompt = `Tu es BatBot IA, assistant d’analyse football. Réponds en français, clairement et prudemment, sans garantie de résultat.\nMatch : ${home} vs ${away}\nContexte : ${context || "Non fourni"}\nPrésente les informations disponibles, les limites des données, des probabilités estimées avec prudence, 1X2, double chance, buts, BTTS, handicap, cotes indicatives présentées comme estimations, niveau de risque et une conclusion courte. N’invente jamais de données en temps réel. Termine par : « BatBot IA vous conseille de jouer avec beaucoup de modération. »`;

  async function askGemini() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY manquante");
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${data?.error?.message || "erreur"}`);
    return data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim();
  }

  async function askMetaFallback() {
    const key = process.env.META_API_KEY;
    const url = process.env.META_API_URL;
    if (!key || !url) throw new Error("META_API_KEY ou META_API_URL manquante");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.META_MODEL || "meta-llama/llama-3.1-8b-instruct", temperature: 0.2, messages: [{ role: "user", content: prompt }] })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Secours ${response.status}: ${data?.error?.message || "erreur"}`);
    return data?.choices?.[0]?.message?.content?.trim() || data?.output?.trim();
  }

  try {
    let analysis;
    let provider = "Gemini";
    try {
      analysis = await askGemini();
    } catch (primaryError) {
      console.warn("Gemini indisponible, tentative du secours:", primaryError.message);
      provider = "secours";
      analysis = await askMetaFallback();
    }
    if (!analysis) return res.status(502).json({ error: "BatBot IA n’a pas retourné de résultat." });
    res.json({ analysis, provider: "BatBot IA" });
  } catch (error) {
    console.error("AI providers error:", error.message);
    res.status(502).json({ error: "BatBot IA est temporairement indisponible. Vérifiez les clés et les paramètres Gemini et du secours dans Render." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`BatBot démarré sur le port ${PORT}`);
});