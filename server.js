const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const { createPostgresSessionStore } = require("./database/postgres-session");
const bcrypt = require("bcryptjs");
const { pool, query: pgQuery, get: pgGet, all: pgAll } = require("./database/postgres-db");
const path = require("path");
const crypto = require("crypto");
const { analyzeSportScoreMatches } = require("./algorithms/sportscore-odds-service");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));


let settingsCache = null;
let settingsCacheExpiresAt = 0;
let dailyMatchesCache = null;
let dailyMatchesCacheKey = "";
let dailyMatchesCacheExpiresAt = 0;





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

async function getSetting(key) {
  return await pgGet("SELECT value FROM settings WHERE key=$1", [key]);
}

async function writeSetting(key, value) {
  const result = await pgQuery(
    "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, String(value)]
  );
  settingsCache = null;
  settingsCacheExpiresAt = 0;
  return result;
}

async function initializeSettings() {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(await getSetting(key))) {
      await writeSetting(key, String(value));
    }
  }

  try {
    const oldNumber = "2250152171974";
    const newNumber = "2250152171974";

    const currentWhatsapp = await getSetting("whatsapp");
    const currentAdminPhone = await getSetting("adminPhone");

    if (currentWhatsapp && String(currentWhatsapp.value) === oldNumber) {
      await writeSetting("whatsapp", newNumber);
    }

    if (currentAdminPhone && String(currentAdminPhone.value) === oldNumber) {
      await writeSetting("adminPhone", newNumber);
    }
  } catch (_) {}

  if (!(await getSetting("adminPasswordHash"))) {
    await writeSetting(
      "adminPasswordHash",
      bcrypt.hashSync(process.env.ADMIN_PASSWORD || "ChangeMe123!", 12)
    );
  }
}

async function getSettings() {
  const now = Date.now();
  if (settingsCache && settingsCacheExpiresAt > now) return settingsCache;

  const rows = await pgAll("SELECT key,value FROM settings");
  settingsCache = Object.fromEntries(rows.map(x => [x.key, x.value]));
  settingsCacheExpiresAt = now + 5000;
  return settingsCache;
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

async function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Connexion requise." });
  }

  try {
    const user = await pgGet(
      "SELECT id, disabled FROM users WHERE id=$1",
      [req.session.userId]
    );

    if (!user || user.disabled) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Ce compte est désactivé ou introuvable." });
    }

    next();
  } catch (error) {
    console.error("requireUser PostgreSQL:", error);
    return res.status(500).json({ error: "Erreur de vérification du compte." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: "Accès administrateur refusé." });
  }
  next();
}

const postgresSession = createPostgresSessionStore();
const sessionStore = postgresSession
  ? postgresSession.store
  : new SQLiteStore({ db: "sessions.sqlite", dir: __dirname });

if (postgresSession) {
  console.log("BatBot sessions: PostgreSQL partagé activé.");
} else {
  console.log("BatBot sessions: SQLite local (fallback de compatibilité).");
}

app.use(session({
  store: sessionStore,
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

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || password.length < 6) {
    return res.status(400).json({
      error: "Nom d'utilisateur et mot de passe valides requis (6 caractères minimum)."
    });
  }

  try {
    const result = await pgQuery(
      "INSERT INTO users(username,phone,password_hash) VALUES($1,$2,$3) RETURNING id",
      [username, "", bcrypt.hashSync(password, 12)]
    );

    const user = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [result.rows[0].id]
    );

    req.session.userId = Number(user.id);

    res.status(201).json({
      message: "Compte créé avec succès.",
      user: userView(user)
    });
  } catch (error) {
    if (error && error.code === "23505") {
      return res.status(409).json({ error: "Ce nom d'utilisateur existe déjà." });
    }

    console.error("register PostgreSQL:", error);
    res.status(500).json({ error: "Impossible de créer le compte." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  try {
    const user = await pgGet(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (!user || user.disabled) {
      return res.status(401).json({ error: "Identifiants incorrects ou compte désactivé." });
    }

    let validPassword = false;
    let temporaryLogin = false;

    if (user.must_change_password) {
      const expiresAt = user.temporary_password_expires_at
        ? new Date(user.temporary_password_expires_at)
        : null;

      if (!expiresAt || expiresAt <= new Date() || !user.temporary_password_hash) {
        return res.status(401).json({
          error: "Votre mot de passe temporaire a expiré. Faites une nouvelle demande."
        });
      }

      validPassword = bcrypt.compareSync(
        password,
        user.temporary_password_hash
      );
      temporaryLogin = validPassword;
    } else {
      validPassword = bcrypt.compareSync(password, user.password_hash);
    }

    if (!validPassword) {
      return res.status(401).json({
        error: "Identifiants incorrects ou compte désactivé."
      });
    }

    req.session.userId = user.id;

    res.json({
      message: temporaryLogin
        ? "Connexion temporaire réussie. Nouveau mot de passe requis."
        : "Connexion réussie.",
      temporary_login: temporaryLogin,
      must_change_password: Boolean(user.must_change_password),
      user: userView(user)
    });
  } catch (error) {
    console.error("login PostgreSQL:", error);
    res.status(500).json({ error: "Erreur lors de la connexion." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Déconnexion réussie." }));
});

app.get("/api/me", requireUser, async (req, res) => {
  try {
    const user = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );

    if (!user) return res.status(401).json({ error: "Session invalide." });

    res.json({ user: userView(user) });
  } catch (error) {
    console.error("api/me PostgreSQL:", error);
    res.status(500).json({ error: "Impossible de récupérer le compte." });
  }
});

app.post("/api/password-reset", async (req, res) => {
  const username = String(req.body.username || "").trim();

  try {
    const user = await pgGet(
      "SELECT id, disabled FROM users WHERE username=$1",
      [username]
    );

    if (!user || user.disabled) {
      return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
    }

    let request = await pgGet(
      "SELECT id, delivery_token, status FROM password_resets WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
      [user.id]
    );

    if (!request) {
      const deliveryToken = crypto.randomBytes(32).toString("hex");
      const result = await pgQuery(
        "INSERT INTO password_resets(user_id,delivery_token) VALUES($1,$2) RETURNING id,delivery_token,status",
        [user.id, deliveryToken]
      );
      request = result.rows[0];
    } else if (!request.delivery_token) {
      request.delivery_token = crypto.randomBytes(32).toString("hex");
      await pgQuery(
        "UPDATE password_resets SET delivery_token=$1 WHERE id=$2",
        [request.delivery_token, request.id]
      );
    }

    res.json({
      message: "Demande bien envoyée au service BatBot. Veuillez patienter pendant le traitement ; votre mot de passe temporaire apparaîtra automatiquement ici dès qu’il sera prêt.",
      request_id: request.id,
      request_token: request.delivery_token
    });
  } catch (error) {
    console.error("password-reset PostgreSQL:", error);
    res.status(500).json({ error: "Impossible d'enregistrer la demande de récupération." });
  }
});

// Compatibilité avec les anciennes versions de l'interface.
app.post("/api/forgot-password", async (req, res) => {
  const username = String(req.body.username || "").trim();

  try {
    const user = await pgGet(
      "SELECT id, disabled FROM users WHERE username=$1",
      [username]
    );

    if (!user || user.disabled) {
      return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
    }

    let existing = await pgGet(
      "SELECT id, delivery_token FROM password_resets WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
      [user.id]
    );

    if (!existing) {
      const deliveryToken = crypto.randomBytes(32).toString("hex");
      const result = await pgQuery(
        "INSERT INTO password_resets(user_id,delivery_token) VALUES($1,$2) RETURNING id,delivery_token",
        [user.id, deliveryToken]
      );
      existing = result.rows[0];
    } else if (!existing.delivery_token) {
      existing.delivery_token = crypto.randomBytes(32).toString("hex");
      await pgQuery(
        "UPDATE password_resets SET delivery_token=$1 WHERE id=$2",
        [existing.delivery_token, existing.id]
      );
    }

    res.json({
      message: "Demande bien envoyée au service BatBot. Veuillez patienter pendant le traitement ; votre mot de passe temporaire apparaîtra automatiquement ici dès qu’il sera prêt.",
      request_id: existing.id,
      request_token: existing.delivery_token
    });
  } catch (error) {
    console.error("forgot-password PostgreSQL:", error);
    res.status(500).json({ error: "Impossible d'enregistrer la demande de récupération." });
  }
});

// Vérification sécurisée de la demande depuis l'espace de connexion.
// Le token est un secret temporaire conservé uniquement dans la session locale du navigateur.
app.get("/api/password-reset/status", async (req, res) => {
  const token = String(req.query.token || "").trim();

  if (!token || token.length < 40) {
    return res.status(400).json({ error: "Jeton de récupération invalide." });
  }

  try {
    const request = await pgGet(`
      SELECT
        pr.id,
        pr.status,
        pr.temporary_password_encrypted,
        pr.temporary_password_expires_at,
        u.username,
        u.disabled,
        u.must_change_password
      FROM password_resets pr
      JOIN users u ON u.id = pr.user_id
      WHERE pr.delivery_token=$1
      ORDER BY pr.id DESC
      LIMIT 1
    `, [token]);

    if (!request || request.disabled) {
      return res.status(404).json({ error: "Demande introuvable." });
    }

    if (request.status === "pending") {
      return res.json({
        status: "pending",
        username: request.username
      });
    }

    const expiresAt = request.temporary_password_expires_at
      ? new Date(request.temporary_password_expires_at)
      : null;

    if (!expiresAt || expiresAt <= new Date()) {
      return res.json({
        status: "expired",
        username: request.username
      });
    }

    const temporaryPassword = decryptTemporaryPassword(
      request.temporary_password_encrypted
    );

    if (!temporaryPassword) {
      return res.status(500).json({
        error: "Impossible de récupérer le mot de passe temporaire."
      });
    }

    res.json({
      status: "ready",
      username: request.username,
      temporary_password: temporaryPassword,
      expires_at: request.temporary_password_expires_at
    });
  } catch (error) {
    console.error("password-reset/status PostgreSQL:", error);
    res.status(500).json({
      error: "Impossible de vérifier la demande de récupération."
    });
  }
});

app.post("/api/password-change", requireUser, async (req, res) => {
  const password = String(req.body.password || "");
  const confirmation = String(req.body.confirm_password || "");

  if (password.length < 6) {
    return res.status(400).json({
      error: "Le nouveau mot de passe doit contenir au moins 6 caractères."
    });
  }

  if (password !== confirmation) {
    return res.status(400).json({
      error: "Les deux mots de passe ne correspondent pas."
    });
  }

  try {
    const user = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );

    if (!user || user.disabled) {
      return res.status(403).json({ error: "Compte indisponible." });
    }

    const result = await pgQuery(`
      UPDATE users
      SET password_hash=$1,
          must_change_password=false,
          temporary_password_hash=NULL,
          temporary_password_expires_at=NULL
      WHERE id=$2
    `, [
      bcrypt.hashSync(password, 12),
      user.id
    ]);

    if (!result.rowCount) {
      return res.status(500).json({
        error: "Impossible de modifier le mot de passe."
      });
    }

    const updatedUser = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [user.id]
    );

    res.json({
      message: "Votre nouveau mot de passe a été enregistré avec succès.",
      user: userView(updatedUser)
    });
  } catch (error) {
    console.error("password-change PostgreSQL:", error);
    res.status(500).json({
      error: "Impossible de modifier le mot de passe."
    });
  }
});

app.get("/api/daily-matches", requireUser, async (req, res) => {
  const cacheKey = today();
  const now = Date.now();

  try {
    if (
      !dailyMatchesCache ||
      dailyMatchesCacheKey !== cacheKey ||
      dailyMatchesCacheExpiresAt <= now
    ) {
      dailyMatchesCache = await pgAll(
        "SELECT * FROM daily_matches WHERE match_date=$1 ORDER BY id DESC",
        [cacheKey]
      );
      dailyMatchesCacheKey = cacheKey;
      dailyMatchesCacheExpiresAt = now + 10000;
    }

    res.set("Cache-Control", "private, max-age=10");
    res.json({ matches: dailyMatchesCache });
  } catch (error) {
    console.error("daily-matches PostgreSQL:", error);
    res.status(500).json({
      error: "Impossible de récupérer les matchs du jour."
    });
  }
});

app.post("/api/analysis-requests", requireUser, async (req, res) => {
  const type = String(req.body.type || "football").trim().toLowerCase();
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

  const row = await pgGet(
    `INSERT INTO analysis_requests(user_id,type,content)
     VALUES($1,$2,$3)
     RETURNING id`,
    [req.session.userId, type, content]
  );

  const id = row.id;
  const settings = await getSettings();
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
});;

async function cleanupExpiredBatBotMessages() {
  try {
    const result = await pgQuery(
      "DELETE FROM batbot_messages WHERE expires_at <= CURRENT_TIMESTAMP"
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error("BATBOT MESSAGE CLEANUP:", error.message);
    return 0;
  }
}
cleanupExpiredBatBotMessages();
setInterval(cleanupExpiredBatBotMessages, 5 * 60 * 1000).unref();

app.get("/api/messages/mine", requireUser, async (req, res) => {
  const messages = await pgAll(`
    SELECT m.id,m.title,m.body,m.created_at,m.expires_at,
           CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END AS is_read
    FROM batbot_messages m
    LEFT JOIN batbot_message_reads r
      ON r.message_id=m.id AND r.user_id=$1
    WHERE m.expires_at > CURRENT_TIMESTAMP
    ORDER BY m.id DESC
  `, [req.session.userId]);

  res.json({
    messages: messages.map(x => ({
      ...x,
      is_read: Boolean(x.is_read)
    }))
  });
});
app.post("/api/messages/:id/read", requireUser, async (req, res) => {
  const id = Number(req.params.id);

  const message = await pgGet(
    "SELECT id FROM batbot_messages WHERE id=$1 AND expires_at>CURRENT_TIMESTAMP",
    [id]
  );

  if (!message) {
    return res.status(404).json({ error: "Message introuvable ou expiré." });
  }

  await pgQuery(
    "INSERT INTO batbot_message_reads(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [id, req.session.userId]
  );

  res.json({ message: "Message marqué comme lu." });
});
app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  await cleanupExpiredBatBotMessages();

  const messages = await pgAll(`
    SELECT id,title,body,created_at,expires_at
    FROM batbot_messages
    WHERE expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC
  `);

  res.json({ messages });
});
app.post("/api/admin/messages", requireAdmin, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();

  if (!title || !body) {
    return res.status(400).json({
      error: "Le titre et le contenu du message sont obligatoires."
    });
  }

  if (title.length > 120) {
    return res.status(400).json({
      error: "Le titre ne doit pas dépasser 120 caractères."
    });
  }

  if (body.length > 2000) {
    return res.status(400).json({
      error: "Le contenu ne doit pas dépasser 2000 caractères."
    });
  }

  await cleanupExpiredBatBotMessages();

  const result = await pgQuery(
    `INSERT INTO batbot_messages(title,body,created_at,expires_at)
     VALUES($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '24 hours')
     RETURNING id,title,body,created_at,expires_at`,
    [title, body]
  );

  const created = result.rows[0];

  res.status(201).json({
    message: "Message publié avec succès. Il restera visible pendant 24 heures.",
    id: Number(created.id),
    expires_at: created.expires_at
  });
});
app.delete("/api/admin/messages/:id", requireAdmin, async (req, res) => {
  const result = await pgQuery(
    "DELETE FROM batbot_messages WHERE id=$1",
    [Number(req.params.id)]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Message introuvable." });
  }

  res.json({ message: "Message supprimé avec succès." });
});

app.post("/api/admin/login", async (req, res) => {
  const settings = await getSettings();
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

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const users = await pgGet("SELECT COUNT(*) AS n FROM users");
  const analyses = await pgGet("SELECT COUNT(*) AS n FROM analysis_requests");
  const pending = await pgGet("SELECT COUNT(*) AS n FROM analysis_requests WHERE status='pending'");
  const passwordResets = await pgGet("SELECT COUNT(*) AS n FROM password_resets WHERE status='pending'");

  res.json({
    users: Number(users?.n || 0),
    analyses: Number(analyses?.n || 0),
    pending: Number(pending?.n || 0),
    password_resets: Number(passwordResets?.n || 0)
  });
});

app.post("/api/payment-requests", requireUser, async (req, res) => {
  const offer = String(req.body.offer || "").trim();
  const operator = String(req.body.operator || "").trim();
  const amount = Number(req.body.amount);
  const reference = String(req.body.reference || "").trim();
  const allowedOperators = ["Orange Money", "MTN Money", "Moov Money", "Wave"];

  if (!offer || !allowedOperators.includes(operator) || !Number.isFinite(amount) || amount <= 0 || !reference) {
    return res.status(400).json({ error: "Veuillez remplir correctement tous les champs du paiement." });
  }
  const result = await pgGet(
    `INSERT INTO payment_requests(user_id,offer,operator,amount,reference)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id`,
    [req.session.userId, offer, operator, Math.round(amount), reference]
  );
  res.json({ message: "Référence enregistrée. Envoyez maintenant votre preuve sur WhatsApp.", id: result.id });
});

app.get("/api/payment-requests/mine", requireUser, async (req, res) => {
  const requests = await pgAll(`
    SELECT id, offer, operator, amount, reference, status, admin_note, created_at, resolved_at
    FROM payment_requests
    WHERE user_id=$1
    ORDER BY id DESC
  `, [req.session.userId]);
  res.json({ requests });
});

app.get("/api/admin/payment-requests", requireAdmin, async (req, res) => {
  const requests = await pgAll(`
    SELECT p.*, u.username, u.phone
    FROM payment_requests p
    LEFT JOIN users u ON u.id=p.user_id
    ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END, p.id DESC
  `);
  res.json({ requests });
});

app.patch("/api/admin/payment-requests/:id", requireAdmin, async (req, res) => {
  const status = String(req.body.status || "").toLowerCase();
  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Statut invalide." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query(
      "SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",
      [Number(req.params.id)]
    );
    const request = requestResult.rows[0];

    if (!request) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Demande introuvable." });
    }

    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cette demande a déjà été traitée." });
    }

    if (status === "accepted" && /premium/i.test(request.offer)) {
      const durationDays = /30\s*j|30\s*jours/i.test(request.offer) ? 30 : 7;
      const now = new Date();

      const userResult = await client.query(
        "SELECT premium_until, ai_until FROM users WHERE id=$1 FOR UPDATE",
        [request.user_id]
      );
      const user = userResult.rows[0];

      if (!user) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Utilisateur introuvable." });
      }

      const currentUntil =
        user.premium_until && new Date(user.premium_until) > now
          ? new Date(user.premium_until)
          : now;

      const until = new Date(
        currentUntil.getTime() + durationDays * 24 * 60 * 60 * 1000
      ).toISOString();

      await client.query(
        "UPDATE users SET premium_started_at=$1, premium_until=$2 WHERE id=$3",
        [now.toISOString(), until, request.user_id]
      );

      if (/ia/i.test(request.offer)) {
        await client.query(
          "UPDATE users SET ai_started_at=$1, ai_until=$2 WHERE id=$3",
          [now.toISOString(), until, request.user_id]
        );
      }
    }

    const result = await client.query(
      "UPDATE payment_requests SET status=$1, resolved_at=CURRENT_TIMESTAMP WHERE id=$2 AND status='pending'",
      [status, request.id]
    );

    if (result.rowCount !== 1) {
      throw new Error("Cette demande a déjà été traitée.");
    }

    await client.query("COMMIT");

    res.json({
      message: status === "accepted" ? "Paiement accepté." : "Paiement refusé."
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    res.status(409).json({
      error: error.message || "Demande déjà traitée."
    });
  } finally {
    client.release();
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const users = await pgAll("SELECT * FROM users ORDER BY id DESC");
  res.json({
    users: users.map(userView)
  });
});

app.post("/api/admin/subscription", requireAdmin, async (req, res) => {
  const id = Number(req.body.user_id);
  const active = Boolean(req.body.active);
  const durationDays = Math.max(
    1,
    Math.min(3650, Number(req.body.duration_days) || 7)
  );

  const startedAt = active ? new Date() : null;
  const until = active
    ? new Date(startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const result = await pgQuery(
    "UPDATE users SET premium_started_at=$1, premium_until=$2 WHERE id=$3",
    [startedAt ? startedAt.toISOString() : null, until, id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({
    message: active
      ? `Premium activé pour ${durationDays} jour(s).`
      : "Premium désactivé."
  });
});
// Activation de l'accès IA : l'utilisateur doit aussi avoir Premium actif.
app.post("/api/admin/ai-subscription", requireAdmin, async (req, res) => {
  const id = Number(req.body.user_id);
  const active = Boolean(req.body.active);
  const durationDays = Math.max(
    1,
    Math.min(3650, Number(req.body.duration_days) || 7)
  );

  const user = await pgGet(
    "SELECT * FROM users WHERE id=$1",
    [id]
  );

  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  if (active) {
    const premiumActive = !!(
      user.premium_until &&
      new Date(user.premium_until) > new Date()
    );

    if (!premiumActive) {
      return res.status(400).json({
        error: "Activez d’abord Premium pour autoriser l’accès à l’IA."
      });
    }

    const startedAt = new Date();
    const until = new Date(
      Date.now() + durationDays * 24 * 60 * 60 * 1000
    ).toISOString();

    await pgQuery(
      "UPDATE users SET ai_started_at=$1, ai_until=$2 WHERE id=$3",
      [startedAt.toISOString(), until, id]
    );

    return res.json({
      message: `IA activée pour ${durationDays} jour(s).`,
      ai_until: until
    });
  }

  await pgQuery(
    "UPDATE users SET ai_until=NULL WHERE id=$1",
    [id]
  );

  res.json({ message: "Accès IA désactivé." });
});
app.patch("/api/admin/users/:id/status", requireAdmin, async (req, res) => {
  const disabled = Boolean(req.body.disabled);

  const result = await pgQuery(
    "UPDATE users SET disabled=$1 WHERE id=$2",
    [disabled, Number(req.params.id)]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({
    message: disabled ? "Compte désactivé." : "Compte réactivé."
  });
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  const password = String(req.body.password || "");

  if (password.length < 6) {
    return res.status(400).json({ error: "Minimum 6 caractères." });
  }

  const result = await pgQuery(
    `UPDATE users
     SET password_hash=$1,
         must_change_password=false,
         temporary_password_hash=NULL,
         temporary_password_expires_at=NULL
     WHERE id=$2`,
    [bcrypt.hashSync(password, 12), Number(req.body.user_id)]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({ message: "Mot de passe modifié avec succès." });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const result = await pgQuery(
    "DELETE FROM users WHERE id=$1",
    [Number(req.params.id)]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }

  res.json({ message: "Membre supprimé." });
});

app.get("/api/admin/password-resets", requireAdmin, async (req, res) => {
  const requests = await pgAll(`
    SELECT pr.*, u.username, u.phone
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.status='pending'
    ORDER BY pr.id DESC
  `);

  res.json({ requests });
});

// Alias utilisé par l'interface actuelle.
app.get("/api/admin/reset-requests", requireAdmin, async (req, res) => {
  const requests = await pgAll(`
    SELECT pr.*, u.username, u.phone
    FROM password_resets pr
    JOIN users u ON u.id=pr.user_id
    WHERE pr.status='pending'
    ORDER BY pr.id DESC
  `);

  res.json({ requests });
});

app.post("/api/admin/reset-requests/:id/resolve", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  const request = await pgGet(
    `
      SELECT pr.id, pr.user_id, pr.status, pr.delivery_token,
             u.username, u.disabled
      FROM password_resets pr
      JOIN users u ON u.id=pr.user_id
      WHERE pr.id=$1
    `,
    [id]
  );

  if (!request) {
    return res.status(404).json({ error: "Demande introuvable." });
  }

  if (request.status !== "pending") {
    return res.status(409).json({
      error: "Cette demande a déjà été traitée."
    });
  }

  if (request.disabled) {
    return res.status(409).json({
      error: "Ce compte est désactivé."
    });
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let temporaryPassword = "BBOT-";
  const bytes = crypto.randomBytes(8);

  for (const byte of bytes) {
    temporaryPassword += alphabet[byte % alphabet.length];
  }

  const expiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000
  ).toISOString();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE users
        SET temporary_password_hash=$1,
            temporary_password_expires_at=$2,
            must_change_password=true
        WHERE id=$3
      `,
      [
        bcrypt.hashSync(temporaryPassword, 12),
        expiresAt,
        request.user_id
      ]
    );

    const resolved = await client.query(
      `
        UPDATE password_resets
        SET status='resolved',
            temporary_password_encrypted=$1,
            temporary_password_expires_at=$2,
            resolved_at=CURRENT_TIMESTAMP
        WHERE id=$3 AND status='pending'
      `,
      [
        encryptTemporaryPassword(temporaryPassword),
        expiresAt,
        id
      ]
    );

    if (!resolved.rowCount) {
      throw new Error("La demande n'est plus en attente.");
    }

    await client.query("COMMIT");

    res.json({
      message: `Nouveau mot de passe temporaire généré pour ${request.username}.`,
      username: request.username,
      new_password: temporaryPassword,
      expires_at: expiresAt,
      request_token: request.delivery_token
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
app.patch("/api/admin/password-resets/:id", requireAdmin, async (req, res) => {
  const status = req.body.status === "resolved" ? "resolved" : "pending";

  await pgQuery(
    "UPDATE password_resets SET status=$1 WHERE id=$2",
    [status, Number(req.params.id)]
  );

  res.json({ message: "Demande traitée." });
});

app.get("/api/admin/requests", requireAdmin, async (req, res) => {
  const requests = await pgAll(`
    SELECT ar.*, u.username, u.phone
    FROM analysis_requests ar
    LEFT JOIN users u ON u.id=ar.user_id
    ORDER BY ar.id DESC
  `);

  res.json({ requests });
});

app.patch("/api/admin/requests/:id", requireAdmin, async (req, res) => {
  const allowed = ["pending", "processing", "completed", "cancelled"];
  const status = allowed.includes(req.body.status)
    ? req.body.status
    : "pending";

  await pgQuery(
    "UPDATE analysis_requests SET status=$1 WHERE id=$2",
    [status, Number(req.params.id)]
  );

  res.json({ message: "Demande mise à jour." });
});
// ======================================================
// VALIDATION DES ÉQUIPES + TEMPS RÉEL DES PRONOSTICS
// ======================================================
const footballTeamCache = new Map();
const memberPredictionClients = new Set();
const MEMBER_PREDICTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function cleanupExpiredMemberPredictions(notify = true) {
  const result = await pgQuery(
    "DELETE FROM member_predictions WHERE created_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'"
  );

  if (result.rowCount && notify) {
    broadcastMemberPredictionEvent({
      type: "expired",
      count: result.rowCount
    });
  }

  return result.rowCount;
}

function broadcastMemberPredictionEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of memberPredictionClients) {
    try { client.write(data); } catch (_) { memberPredictionClients.delete(client); }
  }
}

async function sportScoreSearchTeams(query, limit = 8) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = new URL("https://sportscore.com/api/v1/search/");
  url.searchParams.set("sport", "football");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(Math.max(Number(limit) || 8, 1), 20)));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`SportScore search HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return Array.isArray(data?.teams) ? data.teams : [];
}

async function validateFootballTeamForAI(teamName, teamId = "") {
  const name = String(teamName || '').trim();
  const id = String(teamId || '').trim();
  if (!name && !id) return false;

  const cacheBase = id ? `id:${id}` : `name:${name}`;
  const cacheKey = cacheBase.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9:]+/g,' ')
    .trim();

  const cached = footballTeamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;

  // 1) Le catalogue local reste prioritaire pour les équipes déjà connues.
  if (name && typeof validateLocalFootballTeam === "function" && validateLocalFootballTeam(name)) {
    footballTeamCache.set(cacheKey, { valid: true, expiresAt: Date.now() + 15 * 60 * 1000 });
    return true;
  }

  // 2) Si l'équipe provient directement d'un résultat SportScore côté navigateur,
  // son slug est déjà un identifiant SportScore exploitable. Cela évite de dépendre
  // d'un appel serveur-à-serveur qui peut être bloqué par l'hébergeur.
  // Les identifiants renvoyés par SportScore peuvent être des slugs, des IDs
  // numériques ou d'autres identifiants courts. Dès lors qu'ils proviennent
  // directement du résultat SportScore côté navigateur, ils sont considérés
  // comme fiables et on évite tout nouvel appel serveur-à-serveur.
  if (id && /^[a-z0-9][a-z0-9_-]{0,199}$/i.test(id)) {
    footballTeamCache.set(cacheKey, { valid: true, slug: id, expiresAt: Date.now() + 15 * 60 * 1000 });
    return true;
  }

  // 3) Fallback : SportScore devient la source officielle de validation des équipes.
  const searchNames = [];
  if (name) searchNames.push(name);
  const simplified = name
    .replace(/\bfootball club\b/gi, " ")
    .replace(/\b(fc|cf|sc|afc|ac)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (simplified && simplified.toLowerCase() !== name.toLowerCase()) searchNames.push(simplified);

  try {
    for (const searchName of searchNames) {
      const teams = await sportScoreSearchTeams(searchName, 10);
      const normalizedTarget = normalizeFootballTeamName(searchName);
      const match = teams.find(team => {
        const candidate = normalizeFootballTeamName(team?.name || "");
        return candidate === normalizedTarget ||
          candidate.includes(normalizedTarget) ||
          normalizedTarget.includes(candidate);
      });
      if (match) {
        footballTeamCache.set(cacheKey, {
          valid: true,
          slug: match.slug || null,
          team: match,
          expiresAt: Date.now() + 15 * 60 * 1000
        });
        return true;
      }
    }

    footballTeamCache.set(cacheKey, { valid: false, expiresAt: Date.now() + 15 * 60 * 1000 });
    return false;
  } catch (error) {
    console.error('TEAM VALIDATION SPORTSCORE:', error.message);
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
// IMPORTANT : ce catalogue est volontairement local : aucune requête externe
// n'est effectuée lors de la publication d'un pronostic membre. SportScore
// est utilisé uniquement par les fonctions football/IA qui en ont besoin.
const FOOTBALL_TEAMS_FILE = path.join(__dirname, "data", "football-teams.json");
let LOCAL_FOOTBALL_TEAMS;
try {
  LOCAL_FOOTBALL_TEAMS = JSON.parse(require("fs").readFileSync(FOOTBALL_TEAMS_FILE, "utf8"));
  if (!Array.isArray(LOCAL_FOOTBALL_TEAMS)) LOCAL_FOOTBALL_TEAMS = [];
  LOCAL_FOOTBALL_TEAMS = LOCAL_FOOTBALL_TEAMS
    .filter(team => typeof team === "string" && team.trim())
    .map(team => team.trim());
} catch (error) {
  // Le catalogue local est un accélérateur de validation, pas une dépendance
  // obligatoire. L'IA peut toujours valider une équipe par son ID ou via
  // la recherche SportScore. Cela évite qu'un déploiement incomplet
  // empêche tout le serveur de démarrer.
  LOCAL_FOOTBALL_TEAMS = [];
  console.warn("CATALOGUE ÉQUIPES LOCALES indisponible, validation SportScore activée:", error.message);
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

async function findActiveCoupon(code, bookmaker) {
  if (!code) return null;

  const normalizedCode = code.trim().toLowerCase();

  const coupons = await pgAll(
    "SELECT id,platform_name,code,platform_url,description FROM coupons WHERE active=true"
  );

  const match = coupons.find(c =>
    String(c.code || "").trim().toLowerCase() === normalizedCode &&
    (!bookmaker ||
      String(c.platform_name || "").trim().toLowerCase() === bookmaker.trim().toLowerCase())
  );

  return match || null;
}

// ======================================================
// PRONOSTICS DES MEMBRES
// ======================================================
app.get("/api/member-predictions", requireUser, async (req, res) => {
  await cleanupExpiredMemberPredictions(false);

  const predictions = await pgAll(`
    SELECT p.id,p.user_id,u.username,p.home_team,p.away_team,
           p.home_probability,p.draw_probability,p.away_probability,
           p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
    FROM member_predictions p
    JOIN users u ON u.id=p.user_id
    WHERE u.disabled=false
      AND p.created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
    ORDER BY p.id DESC
    LIMIT 100
  `);

  res.json({ predictions });
});
app.post("/api/member-predictions", requireUser, async (req, res) => {
  const homeTeam = String(req.body.home_team || "").trim();
  const awayTeam = String(req.body.away_team || "").trim();
  const prediction = String(req.body.prediction || "").trim();
  const couponCode = String(req.body.coupon_code || "").trim();
  const bookmaker = String(req.body.bookmaker || "").trim();

  if (!homeTeam || !awayTeam || !prediction) {
    return res.status(400).json({ error: "Les deux équipes et le pronostic sont obligatoires." });
  }

  if (!["1", "N", "2"].includes(prediction)) {
    return res.status(400).json({ error: "Le pronostic doit être V1, X ou V2." });
  }

  if (!couponCode) {
    return res.status(400).json({ error: "Le code coupon est obligatoire." });
  }

  if (!bookmaker) {
    return res.status(400).json({ error: "Le nom du bookmaker est obligatoire." });
  }

  await cleanupExpiredMemberPredictions(false);

  const recent = await pgGet(
    `
      SELECT id
      FROM member_predictions
      WHERE user_id=$1
        AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
      LIMIT 1
    `,
    [req.session.userId]
  );

  if (recent) {
    return res.status(409).json({
      error: "Vous avez déjà publié un pronostic au cours des dernières 24 heures. Vous pourrez en publier un nouveau après ce délai."
    });
  }

  if (
    homeTeam.length > 80 ||
    awayTeam.length > 80 ||
    prediction.length > 120 ||
    couponCode.length > 120 ||
    bookmaker.length > 80
  ) {
    return res.status(400).json({ error: "Un ou plusieurs champs sont trop longs." });
  }


  const result = await pgQuery(
    `
      INSERT INTO member_predictions(
        user_id,
        home_team,
        away_team,
        home_probability,
        draw_probability,
        away_probability,
        prediction,
        coupon_code,
        bookmaker,
        comment
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `,
    [
      req.session.userId,
      homeTeam,
      awayTeam,
      0,
      0,
      0,
      prediction,
      couponCode,
      bookmaker,
      ""
    ]
  );

  const created = await pgGet(
    `
      SELECT p.id,p.user_id,u.username,p.home_team,p.away_team,
             p.home_probability,p.draw_probability,p.away_probability,
             p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
      FROM member_predictions p
      JOIN users u ON u.id=p.user_id
      WHERE p.id=$1
    `,
    [result.rows[0].id]
  );

  broadcastMemberPredictionEvent({ type: "created", prediction: created });
  return res.status(201).json({
    success: true,
    prediction: created
  });
});

app.get("/api/admin/member-predictions", requireAdmin, async (req, res) => {
  const predictions = await pgAll(`
    SELECT p.id,p.user_id,u.username,u.disabled,p.home_team,p.away_team,
           p.home_probability,p.draw_probability,p.away_probability,
           p.prediction,p.coupon_code,p.bookmaker,p.comment,p.created_at
    FROM member_predictions p
    JOIN users u ON u.id=p.user_id
    ORDER BY p.id DESC
  `);

  res.json({ predictions });
});
app.delete("/api/admin/member-predictions/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  const result = await pgQuery(
    "DELETE FROM member_predictions WHERE id=$1",
    [id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "Pronostic introuvable." });
  }

  broadcastMemberPredictionEvent({ type: "deleted", id });

  res.json({ message: "Pronostic supprimé avec succès." });
});

app.post("/api/admin/daily-matches", requireAdmin, async (req, res) => {
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

  await pgQuery(
    `
      INSERT INTO daily_matches(
        match_name, home_probability, draw_probability,
        away_probability, recommended_pick, odds, match_date
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
    `,
    [name, h, d, a, pick, odds, today()]
  );

  dailyMatchesCache = null;
  dailyMatchesCacheExpiresAt = 0;

  res.status(201).json({ message: "Match ajouté avec succès." });
});
app.get("/api/admin/daily-matches", requireAdmin, async (req, res) => {
  const matches = await pgAll(
    "SELECT * FROM daily_matches WHERE match_date=$1 ORDER BY id DESC",
    [today()]
  );

  res.json({ matches });
});

app.delete("/api/admin/daily-matches/:id", requireAdmin, async (req, res) => {
  await pgQuery(
    "DELETE FROM daily_matches WHERE id=$1",
    [Number(req.params.id)]
  );

  dailyMatchesCache = null;
  dailyMatchesCacheExpiresAt = 0;

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

async function initializeBookmakers() {
  const current = await pgGet(
    "SELECT COUNT(*)::int AS n FROM bookmakers"
  );

  if (current && current.n > 0) {
    return;
  }

  const seed = [
    ["1WIN", "500%", "https://1wyvrz.life/?p=gc9k"],
    ["PARIPESA", "500%", "https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651"],
    ["AFROPARI", "300%", "https://apaff.top/L?tag=d_3763651m_70055c_&site=3763651&ad=70055"],
    ["MELBET", "200%", "https://refpa3665.com/L?tag=d_4685320m_66335c_&site=4685320&ad=663"],
    ["LOTO", "", "https://jdnlotto.com/register?promo=123"]
  ];

  for (const [name, bonus, url] of seed) {
    await pgQuery(
      "INSERT INTO bookmakers(name, bonus, url, active) VALUES($1, $2, $3, true)",
      [name, bonus, url]
    );
  }

  console.log("BatBot: bookmakers PostgreSQL initialisés.");
}

app.get("/api/config", async (req, res) => {
  const s = await getSettings();
  res.json({
    whatsapp: s.whatsapp, telegram: s.telegram,
    whatsappGroup: s.whatsappGroup, telegramGroup: s.telegramGroup,
    tiktok: s.tiktok, facebook: s.facebook, instagram: s.instagram,
    wave500: s.wave500, wave1000: s.wave1000, wavePromo: s.wavePromo,
    promoFee: s.promoFee,
    sdriveLink: s.sdriveLink || "", sdriveInviteMessage: s.sdriveInviteMessage || "",
    bookmakers: await pgAll(
      "SELECT id,name,bonus,url FROM bookmakers WHERE active=true ORDER BY id DESC"
    )
  });
});

app.get("/api/payment-number", requireUser, async (req, res) => {
  const operator = String(req.query.operator || "").trim();
  const keyByOperator = {
    "Orange Money": "orangeMoney",
    "MTN Money": "mtnMoney",
    "Moov Money": "moovMoney"
  };
  const key = keyByOperator[operator];
  if (!key) return res.status(400).json({ error: "Opérateur de paiement invalide." });
  const settings = await getSettings();
  const number = cleanPhone(settings[key]);
  if (!number) return res.status(404).json({ error: "Numéro de dépôt indisponible pour cet opérateur." });
  res.set("Cache-Control","no-store");
  res.json({ number });
});

app.get("/api/coupons", requireUser, async (req, res) => {
  const coupons = await pgAll(
    "SELECT id,platform_name,code,platform_url,description FROM coupons WHERE active=true ORDER BY id DESC"
  );

  res.json({ coupons });
});

app.get("/api/admin/bookmakers", requireAdmin, async (req, res) => {
  const bookmakers = await pgAll("SELECT * FROM bookmakers ORDER BY id DESC");
  res.json({ bookmakers });
});

app.post("/api/admin/bookmakers", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const bonus = String(req.body.bonus || "").trim();
  const url = String(req.body.url || "").trim();
  if (!name || !validHttpUrl(url)) return res.status(400).json({ error: "Nom et lien HTTP/HTTPS valides requis." });

  const active = req.body.active === false ? false : true;

  const result = await pgQuery(
    "INSERT INTO bookmakers(name,bonus,url,active) VALUES($1,$2,$3,$4) RETURNING id",
    [name, bonus, url, active]
  );

  res.status(201).json({
    id: result.rows[0].id,
    message: "Bookmaker ajouté."
  });
});

app.patch("/api/admin/bookmakers/:id", requireAdmin, async (req, res) => {
  const current = await pgGet(
    "SELECT * FROM bookmakers WHERE id=$1",
    [Number(req.params.id)]
  );

  if (!current) {
    return res.status(404).json({ error: "Bookmaker introuvable." });
  }

  const name = String(req.body.name ?? current.name).trim();
  const bonus = String(req.body.bonus ?? current.bonus).trim();
  const url = String(req.body.url ?? current.url).trim();

  if (!name || !validHttpUrl(url)) {
    return res.status(400).json({
      error: "Nom et lien valides requis."
    });
  }

  const active =
    req.body.active === undefined
      ? current.active
      : Boolean(req.body.active);

  await pgQuery(
    "UPDATE bookmakers SET name=$1, bonus=$2, url=$3, active=$4 WHERE id=$5",
    [name, bonus, url, active, current.id]
  );

  res.json({ message: "Bookmaker modifié." });
});


app.delete("/api/admin/bookmakers/:id", requireAdmin, async (req, res) => {
  await pgQuery(
    "DELETE FROM bookmakers WHERE id=$1",
    [Number(req.params.id)]
  );

  res.json({ message: "Bookmaker supprimé." });
});


app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
  const coupons = await pgAll("SELECT * FROM coupons ORDER BY id DESC");
  res.json({ coupons });
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  const platformName = String(req.body.platform_name || "").trim();
  const code = String(req.body.code || "").trim();
  const platformUrl = String(req.body.platform_url || "").trim();
  const description = String(req.body.description || "").trim();

  if (!platformName || !code || !validHttpUrl(platformUrl)) {
    return res.status(400).json({ error: "Plateforme, code et lien valides requis." });
  }

  const active = req.body.active === false ? false : true;

  const result = await pgQuery(
    "INSERT INTO coupons(platform_name,code,platform_url,description,active) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [platformName, code, platformUrl, description, active]
  );

  res.status(201).json({
    id: result.rows[0].id,
    message: "Coupon ajouté."
  });
});

app.patch("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  const c = await pgGet(
    "SELECT * FROM coupons WHERE id=$1",
    [Number(req.params.id)]
  );

  if (!c) return res.status(404).json({ error: "Coupon introuvable." });

  const data = {
    platform_name: String(req.body.platform_name ?? c.platform_name).trim(),
    code: String(req.body.code ?? c.code).trim(),
    platform_url: String(req.body.platform_url ?? c.platform_url).trim(),
    description: String(req.body.description ?? c.description).trim(),
    active: req.body.active === undefined ? c.active : Boolean(req.body.active)
  };

  if (!data.platform_name || !data.code || !validHttpUrl(data.platform_url)) {
    return res.status(400).json({ error: "Données de coupon invalides." });
  }

  await pgQuery(
    "UPDATE coupons SET platform_name=$1,code=$2,platform_url=$3,description=$4,active=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6",
    [
      data.platform_name,
      data.code,
      data.platform_url,
      data.description,
      data.active,
      c.id
    ]
  );

  res.json({ message: "Coupon modifié." });
});
app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  await pgQuery(
    "DELETE FROM coupons WHERE id=$1",
    [Number(req.params.id)]
  );

  res.json({ message: "Coupon supprimé." });
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  const s = await getSettings(); delete s.adminPasswordHash;
  res.json({ settings: s });
});

app.patch("/api/admin/settings", requireAdmin, async (req, res) => {
  const allowed = [
    "whatsapp", "telegram", "whatsappGroup", "telegramGroup",
    "tiktok", "facebook", "instagram", "wave500", "wave1000",
    "wavePromo", "promoFee", "orangeMoney", "moovMoney", "mtnMoney",
    "adminPhone", "sdriveLink", "sdriveInviteMessage"
  ];
  for (const key of allowed) if (req.body[key] !== undefined) await writeSetting(key, String(req.body[key]));
  const settings = await getSettings(); delete settings.adminPasswordHash;
  res.json({ message: "Configuration enregistrée.", settings });
});


app.post("/api/football/odds", requireUser, async (req, res) => {
  try {
    const currentUser = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );
    const premiumActive = !!(
      currentUser &&
      currentUser.premium_until &&
      new Date(currentUser.premium_until) > new Date()
    );

    if (!premiumActive) {
      return res.status(403).json({
        ok: false,
        error: "Un abonnement Premium actif est nécessaire pour utiliser l'analyse statistique des cotes."
      });
    }

    const matches = Array.isArray(req.body.matches)
      ? req.body.matches
      : [];

    if (!matches.length) {
      return res.status(400).json({
        ok: false,
        error: "Aucun match à analyser."
      });
    }

    const analysis = await analyzeSportScoreMatches(matches);

    return res.json({
      ok: true,
      source: "SportScore",
      ...analysis
    });
  } catch (error) {
    console.error("SportScore odds analysis:", error.message);

    return res.status(502).json({
      ok: false,
      source: "SportScore",
      error: "Impossible de calculer l'analyse statistique des cotes.",
      details: error.message
    });
  }
});

app.post("/api/ai/analyze", requireUser, async (req, res) => {
  // BATBOT IA externe est volontairement détachée du circuit d'analyse football.
  // Le code Groq/OpenAI reste conservé et peut être réactivé ultérieurement
  // en définissant BATBOT_EXTERNAL_AI_ENABLED=true.
  if (process.env.BATBOT_EXTERNAL_AI_ENABLED !== "true") {
    return res.status(503).json({
      error: "Le service IA externe est actuellement désactivé. L'analyse football BATBOT fonctionne avec son moteur statistique dédié."
    });
  }

  const user = await pgGet(
    "SELECT * FROM users WHERE id=$1",
    [req.session.userId]
  );
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
  const validation = await Promise.all([
    validateFootballTeamForAI(home, req.body.home_team_id),
    validateFootballTeamForAI(away, req.body.away_team_id),
    ...(secondHome && secondAway
      ? [
          validateFootballTeamForAI(secondHome, req.body.second_home_team_id),
          validateFootballTeamForAI(secondAway, req.body.second_away_team_id)
        ]
      : [])
  ]);
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
  const evidence = req.body.analysis_evidence && typeof req.body.analysis_evidence === "object" ? req.body.analysis_evidence : null;
  const models = Array.isArray(req.body.analysis_models) ? req.body.analysis_models : [];
  const compactEvidence = evidence ? JSON.stringify(evidence).slice(0, 42000) : "Aucune donnée statistique SportScore supplémentaire n’a été fournie.";
  const modelInstruction = models.length ? `\nMODÈLE STATISTIQUE BATBOT (à respecter exactement pour les pourcentages) :\n${JSON.stringify(models)}\nLes valeurs 1/X/2 et les probabilités d’options fournies par ce modèle sont calculées à partir des données SportScore disponibles. Tu ne dois pas les inventer ni les modifier. Tu peux seulement expliquer leur lecture et choisir une recommandation cohérente.` : "";
  const prompt = `Tu es BatBot IA, assistant d’analyse football. Réponds uniquement avec un JSON valide, sans introduction, sans Markdown et sans texte supplémentaire.

Matchs à analyser :
${matches.join("\n")}

DONNÉES SPORTIVES RÉELLES DISPONIBLES (SportScore) :
${compactEvidence}
${modelInstruction}

Objectif : fournir une fiche professionnelle, prudente et cohérente. N’invente jamais une statistique, une blessure, une composition, une cote bookmaker, un résultat ou une information absente des données fournies. Si une information manque, dis simplement qu’elle n’est pas disponible.
Pour chacun des ${matchCount} match${matchCount > 1 ? 's' : ''}, retourne :
- name : nom du match ;
- probabilities : exactement 1, X, 2 avec les valeurs du modèle statistique fournies ;
- options : les options du modèle statistique fournies, avec leurs probabilités inchangées ;
- recommendation : une seule option parmi les options fournies, cohérente avec les probabilités ;
- reason : une explication courte fondée uniquement sur forme récente, buts, H2H et classement disponibles ;
- data_quality : "bonne", "moyenne" ou "limitée" selon la quantité de données réellement disponible.

${combinedInstruction}
Utilise exactement cette structure :
{
  "matches": [
    {
      "name": "...",
      "probabilities": [{"label":"1","value":"..."},{"label":"X","value":"..."},{"label":"2","value":"..."}],
      "options": [{"name":"...","probability":"...","risk":"...","reason":"..."}],
      "recommendation":"...",
      "reason":"...",
      "data_quality":"..."
    }
  ]${combinedStructure}
}`;

  const systemInstruction = "Retourne uniquement le JSON demandé en français. Utilise exclusivement les données SportScore et le modèle statistique fournis. Ne présente jamais une estimation comme une certitude.";

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
    res.json({ analysis, provider: process.env.GROQ_API_KEY ? "groq" : "openai", models });
  } catch (error) {
    console.error("AI request error:", error.message);
    res.status(502).json({ error: "BatBot IA est temporairement indisponible." });
  }
});


// ===== SPORTSCORE FOOTBALL API =====
// Source football principale de BATBOT. SportScore fournit une API REST publique
// sans clé pour le niveau gratuit, avec attribution visible requise.
const SPORTSCORE_BASE = "https://sportscore.com/api/v1";
const footballFixturesCache = new Map();
const FOOTBALL_FIXTURES_CACHE_TTL = 30 * 1000;

function sportScoreUrl(endpoint, params = {}) {
  const url = new URL(`${SPORTSCORE_BASE}/${endpoint.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  // Identifie volontairement l'application dans les statistiques de SportScore.
  url.searchParams.set("src", "batbot");
  return url;
}

async function callSportScore(endpoint, params = {}) {
  const url = sportScoreUrl(endpoint, params);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || data?.message || `SportScore HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status || 502;
    throw error;
  }
  return data;
}

function sportScoreStatus(status, statusText) {
  const value = String(status || "").toLowerCase();
  if (value === "live") return { short: "LIVE", long: statusText || "En direct" };
  if (value === "finished") return { short: "FT", long: statusText || "Terminé" };
  return { short: "NS", long: statusText || "Programmé" };
}

function normalizeSportScoreMatch(match, index = 0) {
  const homeName = String(match?.home || match?.home_team || "Équipe 1").trim();
  const awayName = String(match?.away || match?.away_team || "Équipe 2").trim();
  const homeScore = Number.isFinite(Number(match?.home_score)) ? Number(match.home_score) : null;
  const awayScore = Number.isFinite(Number(match?.away_score)) ? Number(match.away_score) : null;
  const date = match?.time || match?.date || null;
  const competitionName = match?.competition || match?.league || "Compétition";
  const slug = match?.slug || `${homeName}-vs-${awayName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    fixture: {
      id: String(match?.id || slug || index),
      date,
      status: sportScoreStatus(match?.status, match?.status_text)
    },
    teams: {
      home: { id: String(match?.home_slug || homeName), name: homeName, logo: match?.home_logo || null },
      away: { id: String(match?.away_slug || awayName), name: awayName, logo: match?.away_logo || null }
    },
    league: {
      id: String(match?.competition_slug || competitionName),
      name: competitionName,
      slug: match?.competition_slug || null
    },
    goals: { home: homeScore, away: awayScore },
    score: { fulltime: { home: homeScore, away: awayScore } },
    sportscore: {
      slug,
      uri: match?.uri || null,
      status: match?.status || null,
      status_text: match?.status_text || null,
      raw: match
    }
  };
}

function currentAbidjanDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

async function getSportScoreFixtures(params = {}) {
  const cacheKey = JSON.stringify(params);
  const cached = footballFixturesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };

  const data = await callSportScore("fixtures/", {
    sport: "football",
    limit: 200,
    ...params
  });
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  const value = {
    sport: "football",
    count: Number(data?.count ?? matches.length),
    matches,
    updated: data?.updated || null
  };
  footballFixturesCache.set(cacheKey, { value, expiresAt: Date.now() + FOOTBALL_FIXTURES_CACHE_TTL });
  return { ...value, cached: false };
}

app.get("/api/football/access", requireUser, async (req, res) => {
  try {
    const currentUser = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );
    const premiumActive = !!(currentUser && currentUser.premium_until && new Date(currentUser.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(403).json({ ok: false, error: "Un abonnement Premium actif est nécessaire pour accéder aux données football." });
    }
    return res.json({ ok: true, source: "sportscore", access: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Vérification de l'accès football indisponible." });
  }
});

app.get("/api/football/fixtures", requireUser, async (req, res) => {
  try {
    const currentUser = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );
    const premiumActive = !!(currentUser && currentUser.premium_until && new Date(currentUser.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(403).json({ ok: false, error: "Un abonnement Premium actif est nécessaire pour accéder aux matchs." });
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : currentAbidjanDate();
    const statusFilter = String(req.query.status || "").trim();
    const params = { date };
    if (["live", "finished", "upcoming"].includes(statusFilter)) params.status = statusFilter;

    const data = await getSportScoreFixtures(params);
    const fixtures = data.matches.map(normalizeSportScoreMatch);

    res.json({
      ok: true,
      source: "sportscore",
      checked_date: date,
      results_count: fixtures.length,
      updated: data.updated,
      cached: data.cached,
      response: fixtures
    });
  } catch (error) {
    console.error("SportScore fixtures:", error.message);
    res.status(error.status || 502).json({
      ok: false,
      source: "sportscore",
      error: "Impossible de récupérer les matchs SportScore.",
      details: error.message
    });
  }
});

app.get("/api/football/live", requireUser, async (req, res) => {
  try {
    const currentUser = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [req.session.userId]
    );
    const premiumActive = !!(currentUser && currentUser.premium_until && new Date(currentUser.premium_until) > new Date());
    if (!premiumActive) {
      return res.status(403).json({ ok: false, error: "Un abonnement Premium actif est nécessaire pour accéder aux matchs en direct." });
    }

    const data = await getSportScoreFixtures({ status: "live" });
    const fixtures = data.matches.map(normalizeSportScoreMatch);
    res.json({
      ok: true,
      source: "sportscore",
      live: true,
      results_count: fixtures.length,
      updated: data.updated,
      response: fixtures
    });
  } catch (error) {
    console.error("SportScore live:", error.message);
    res.status(error.status || 502).json({
      ok: false,
      source: "sportscore",
      error: "Impossible de récupérer les matchs en direct SportScore.",
      details: error.message
    });
  }
});

app.get("/api/football/search", requireUser, async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2) return res.status(400).json({ ok: false, error: "La recherche doit contenir au moins 2 caractères." });
    const teams = await sportScoreSearchTeams(query, 20);
    res.json({ ok: true, source: "sportscore", query, teams });
  } catch (error) {
    console.error("SportScore search:", error.message);
    res.status(error.status || 502).json({ ok: false, source: "sportscore", error: "Recherche d'équipe indisponible.", details: error.message });
  }
});

app.get("/api/football/h2h", requireUser, async (req, res) => {
  try {
    const team1 = String(req.query.team1 || "").trim();
    const team2 = String(req.query.team2 || "").trim();
    if (!team1 || !team2) return res.status(400).json({ ok: false, error: "Les deux équipes sont nécessaires pour le H2H." });
    const data = await callSportScore("h2h/", { sport: "football", team1, team2, limit: 20 });
    res.json({ ok: true, source: "sportscore", ...data });
  } catch (error) {
    console.error("SportScore H2H:", error.message);
    res.status(error.status || 502).json({ ok: false, source: "sportscore", error: "Historique H2H indisponible.", details: error.message });
  }
});

app.get("/api/football/match", requireUser, async (req, res) => {
  try {
    const slug = String(req.query.slug || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "Le slug du match est nécessaire." });
    const data = await callSportScore("match/", { sport: "football", slug });
    res.json({ ok: true, source: "sportscore", ...data });
  } catch (error) {
    console.error("SportScore match:", error.message);
    res.status(error.status || 502).json({ ok: false, source: "sportscore", error: "Détails du match indisponibles.", details: error.message });
  }
});

app.get("/api/football/status", requireUser, async (_req, res) => {
  res.json({
    ok: true,
    source: "sportscore",
    api_key_required: false,
    attribution_required: true,
    message: "SportScore est la source football active de BATBOT."
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let server;

async function startServer() {
  try {
    await initializeSettings();
    await initializeBookmakers();

    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`BatBot démarré sur le port ${PORT}`);
    });
  } catch (error) {
    console.error("BatBot: échec de l'initialisation PostgreSQL/settings:", error);
    process.exit(1);
  }
}

startServer();

function shutdown(signal) {
  console.log(`BatBot: arrêt demandé (${signal})`);
  server.close(async () => {
    try {
      if (postgresSession) await postgresSession.pool.end();
    } catch (error) {
      console.error("POSTGRES SESSION CLOSE:", error.message);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
