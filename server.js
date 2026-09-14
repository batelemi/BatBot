const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB = new Database(path.join(DATA_DIR, "sdrive.db"));
DB.pragma("journal_mode = WAL");
DB.pragma("foreign_keys = ON");

const requiredInProduction = ["SESSION_SECRET", "ADMIN_PHONE", "ADMIN_PASSWORD"];
if (process.env.NODE_ENV === "production") {
  const missing = requiredInProduction.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error("Variables Render manquantes :", missing.join(", "));
    process.exit(1);
  }
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-only-change-this-session-secret";
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const DEFAULTS = {
  whatsapp: process.env.WHATSAPP_NUMBER || "",
  telegram: process.env.TELEGRAM_URL || "https://t.me/sdrive123",
  whatsappGroup:
    process.env.WHATSAPP_GROUP_URL ||
    "https://chat.whatsapp.com/GikWdoQLZ8TFDHK2rTHH8T?s=cl&p=a&mlu=4&ilr=4",
  telegramGroup: process.env.TELEGRAM_GROUP_URL || "https://t.me/sdrive123",
  tiktok:
    process.env.TIKTOK_URL ||
    "https://www.tiktok.com/@batelemi92",
  facebook:
    process.env.FACEBOOK_URL ||
    "https://www.facebook.com/share/1L96SqLnZT/",
  instagram:
    process.env.INSTAGRAM_URL ||
    "https://www.instagram.com/wonda_boss_officil/",
  wave500:
    process.env.WAVE_500_URL ||
    "https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=500",
  wave1000:
    process.env.WAVE_1000_URL ||
    "https://pay.wave.com/m/M_ci_kpNTVGT9JGah/c/ci/?amount=1000",
  wavePromo: process.env.WAVE_PROMO || "WAVE22",
  promoFee: process.env.PROMO_FEE || "45CFA",
  orangeMoney: process.env.ORANGE_MONEY || "",
  moovMoney: process.env.MOOV_MONEY || "",
  mtnMoney: process.env.MTN_MONEY || ""
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

DB.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    premium_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_matches (
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

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS analysis_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT NOT NULL CHECK(type IN ('football','loto')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const setSetting = DB.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING"
);
for (const [key, value] of Object.entries(DEFAULTS)) {
  setSetting.run(key, String(value));
}

function normalizePhone(value) {
  let p = String(value || "").trim().replace(/[^\d+]/g, "");
  if (!p) return "";
  if (p.startsWith("+225")) return p.slice(1);
  if (p.startsWith("225")) return p;
  if (p.startsWith("0")) return "225" + p.slice(1);
  return p;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getSettings() {
  return Object.fromEntries(
    DB.prepare("SELECT key,value FROM settings").all().map((row) => [row.key, row.value])
  );
}

function getCurrentUser(req) {
  if (!req.session.userId) return null;
  return DB.prepare(
    "SELECT id,username,premium_until,created_at FROM users WHERE id=?"
  ).get(req.session.userId) || null;
}

function userView(user) {
  if (!user) return null;
  const active =
    !!user.premium_until && new Date(user.premium_until).getTime() > Date.now();
  return {
    id: user.id,
    username: user.username,
    name: user.username,
    premium_until: user.premium_until,
    is_subscribed: active,
    subscribed: active,
    subscription_active: active,
    created_at: user.created_at
  };
}

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Connexion requise." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Accès administrateur requis." });
  }
  next();
}

function whatsappLink(message) {
  const number = normalizePhone(getSettings().whatsapp);
  if (!number) return "";
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

function validateUsername(username) {
  return /^[A-Za-z0-9_.-]{3,30}$/.test(username);
}

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: DATA_DIR
  }),
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

/* Health */
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "S-Drive",
    status: "ok",
    time: new Date().toISOString()
  });
});

/* Public configuration: never expose admin credentials. */
app.get("/api/config", (req, res) => {
  const s = getSettings();
  res.json({
    whatsapp: s.whatsapp,
    telegram: s.telegram,
    whatsappGroup: s.whatsappGroup,
    telegramGroup: s.telegramGroup,
    tiktok: s.tiktok,
    facebook: s.facebook,
    instagram: s.instagram,
    wave500: s.wave500,
    wave1000: s.wave1000,
    wavePromo: s.wavePromo,
    promoFee: s.promoFee,
    orangeMoney: s.orangeMoney,
    moovMoney: s.moovMoney,
    mtnMoney: s.mtnMoney,
    bookmakers: [
      { name: "1WIN", bonus: "500%", url: "https://1wyvrz.life/?p=gc9k" },
      { name: "PARIPESA", bonus: "500%", url: "https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651" },
      { name: "AFROPARI", bonus: "300%", url: "https://apaff.top/L?tag=d_3763651m_70055c_&site=3763651&ad=70055" },
      { name: "MELBET", bonus: "200%", url: "https://refpa3665.com/L?tag=d_4685320m_66335c_&site=4685320&ad=66335" },
      { name: "LOTO", bonus: "", url: "https://jdnlotto.com/register?promo=123" }
    ]
  });
});

/* Client authentication: username + password only. */
app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!validateUsername(username)) {
    return res.status(400).json({
      error: "Le nom d'utilisateur doit contenir 3 à 30 caractères : lettres, chiffres, point, tiret ou underscore."
    });
  }
  if (password.length < 6) {
    return res.status(400).json({
      error: "Le mot de passe doit contenir au moins 6 caractères."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = DB.prepare(
      "INSERT INTO users(username,password_hash) VALUES(?,?)"
    ).run(username, hash);

    req.session.userId = Number(result.lastInsertRowid);
    const user = getCurrentUser(req);
    res.status(201).json({
      message: "Compte créé avec succès.",
      user: userView(user)
    });
  } catch {
    res.status(409).json({
      error: "Ce nom d'utilisateur est déjà utilisé."
    });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Veuillez remplir tous les champs." });
  }

  const user = DB.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
  }

  req.session.userId = user.id;
  res.json({ message: "Connexion réussie.", user: userView(user) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Déconnexion réussie." }));
});

app.get("/api/me", requireUser, (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Session invalide." });
  res.json({ user: userView(user) });
});

/* Password reset: username only. Admin handles the reset. */
app.post("/api/password-reset", (req, res) => {
  const username = String(req.body.username || "").trim();
  if (!username) {
    return res.status(400).json({ error: "Entrez votre nom d'utilisateur." });
  }

  const user = DB.prepare(
    "SELECT id FROM users WHERE username=? COLLATE NOCASE"
  ).get(username);

  /* Same response whether the account exists or not. */
  if (user) {
    const pending = DB.prepare(
      "SELECT id FROM password_resets WHERE user_id=? AND status='pending'"
    ).get(user.id);
    if (!pending) {
      DB.prepare(
        "INSERT INTO password_resets(user_id,status) VALUES(?,'pending')"
      ).run(user.id);
    }
  }

  res.json({
    message: "Si ce compte existe, une demande de réinitialisation a été envoyée à l'administration."
  });
});

/* Daily matches */
app.get("/api/daily-matches", requireUser, (req, res) => {
  res.json({
    matches: DB.prepare(
      "SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC"
    ).all(today())
  });
});

/* Analysis requests */
app.post("/api/analysis-requests", requireUser, (req, res) => {
  const type = req.body.type === "loto" ? "loto" : "football";
  const content = String(req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({
      error:
        type === "loto"
          ? "Indiquez le jeu et les 3 derniers résultats."
          : "Écrivez les matchs ou informations à analyser."
    });
  }

  if (type === "loto" && content.length < 10) {
    return res.status(400).json({
      error: "Pour une analyse Loto, indiquez les 3 derniers résultats."
    });
  }

  const id = DB.prepare(
    "INSERT INTO analysis_requests(user_id,type,content) VALUES(?,?,?)"
  ).run(req.session.userId, type, content).lastInsertRowid;

  const user = getCurrentUser(req);
  const label = type === "loto" ? "Loto" : "Football";
  const message = [
    "Bonjour S-Drive 👋",
    "",
    `Je souhaite demander une analyse ${label}.`,
    "",
    content,
    "",
    `Client : @${user.username}`,
    `Référence : S-Drive #${id}`
  ].join("\n");

  res.status(201).json({
    message: "Demande enregistrée.",
    request_id: Number(id),
    whatsapp: whatsappLink(message),
    telegram: getSettings().telegram || ""
  });
});

/* Admin authentication: phone + password, both from Render environment. */
app.post("/api/admin/login", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || "");

  if (!ADMIN_PHONE || !ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "L'administration n'est pas configurée. Ajoutez ADMIN_PHONE et ADMIN_PASSWORD dans Render."
    });
  }

  if (phone !== ADMIN_PHONE || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Identifiants administrateur incorrects." });
  }

  req.session.admin = true;
  res.json({ message: "Administration ouverte." });
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
  const users = DB.prepare(`
    SELECT id,username,premium_until,created_at
    FROM users ORDER BY id DESC
  `).all().map(userView);
  res.json({ users });
});

app.post("/api/admin/subscription", requireAdmin, (req, res) => {
  const id = Number(req.body.user_id);
  const active = Boolean(req.body.active);
  const until = active
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const result = DB.prepare(
    "UPDATE users SET premium_until=? WHERE id=?"
  ).run(until, id);

  if (!result.changes) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({
    message: active
      ? "Premium activé pour 7 jours."
      : "Premium désactivé."
  });
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  const id = Number(req.body.user_id);
  const password = String(req.body.password || "");

  if (password.length < 6) {
    return res.status(400).json({ error: "Minimum 6 caractères." });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = DB.prepare(
    "UPDATE users SET password_hash=? WHERE id=?"
  ).run(hash, id);

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
      SELECT pr.id,pr.user_id,pr.status,pr.created_at,u.username
      FROM password_resets pr
      JOIN users u ON u.id=pr.user_id
      WHERE pr.status='pending'
      ORDER BY pr.id DESC
    `).all()
  });
});

app.patch("/api/admin/password-resets/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status === "resolved" ? "resolved" : "pending";
  const result = DB.prepare(`
    UPDATE password_resets
    SET status=?, resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id=?
  `).run(status, status, id);

  if (!result.changes) {
    return res.status(404).json({ error: "Demande introuvable." });
  }
  res.json({ message: "Demande traitée." });
});

app.get("/api/admin/requests", requireAdmin, (req, res) => {
  res.json({
    requests: DB.prepare(`
      SELECT ar.*,u.username
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
  const odds =
    req.body.odds === "" || req.body.odds === undefined
      ? null
      : Number(req.body.odds);

  if (
    !name || !pick ||
    ![h, d, a].every(Number.isFinite) ||
    h < 0 || h > 100 || d < 0 || d > 100 || a < 0 || a > 100 ||
    Math.abs(h + d + a - 100) > 0.01
  ) {
    return res.status(400).json({
      error: "Les probabilités doivent être valides et totaliser 100%."
    });
  }

  if (odds !== null && (!Number.isFinite(odds) || odds < 1)) {
    return res.status(400).json({ error: "Cote invalide." });
  }

  DB.prepare(`
    INSERT INTO daily_matches(
      match_name,home_probability,draw_probability,
      away_probability,recommended_pick,odds,match_date
    ) VALUES(?,?,?,?,?,?,?)
  `).run(name, h, d, a, pick, odds, today());

  res.status(201).json({ message: "Match publié avec succès." });
});

app.get("/api/admin/daily-matches", requireAdmin, (req, res) => {
  res.json({
    matches: DB.prepare(
      "SELECT * FROM daily_matches WHERE match_date=? ORDER BY id DESC"
    ).all(today())
  });
});

app.delete("/api/admin/daily-matches/:id", requireAdmin, (req, res) => {
  const result = DB.prepare(
    "DELETE FROM daily_matches WHERE id=?"
  ).run(Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({ error: "Match introuvable." });
  }
  res.json({ message: "Match supprimé." });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({ settings: getSettings() });
});

app.patch("/api/admin/settings", requireAdmin, (req, res) => {
  const allowed = [
    "whatsapp","telegram","whatsappGroup","telegramGroup",
    "tiktok","facebook","instagram",
    "wave500","wave1000","wavePromo","promoFee",
    "orangeMoney","moovMoney","mtnMoney"
  ];

  const update = DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  );

  const transaction = DB.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update.run(key, String(req.body[key]).trim());
      }
    }
  });
  transaction();

  res.json({
    message: "Configuration enregistrée.",
    settings: getSettings()
  });
});


app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Route API introuvable." });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`S-Drive démarré sur le port ${PORT}`);
});
