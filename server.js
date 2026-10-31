// PostgreSQL hébergé exige SSL si aucun réglage explicite n'est fourni.
if (process.env.DATABASE_URL && !process.env.PGSSL) {
  process.env.PGSSL = "require";
}

const express = require("express");
const session = require("express-session");
const { createPostgresSessionStore } = require("./database/postgres-session");
const bcrypt = require("bcryptjs");
const { pool, query: pgQuery, get: pgGet, all: pgAll } = require("./database/postgres-db");
const path = require("path");
const crypto = require("crypto");

const SECURITY_QUESTIONS = [
  "Quel est le prénom de votre meilleur ami d’enfance ?",
  "Dans quelle ville êtes-vous né(e) ?",
  "Quel était le surnom que l’on vous donnait enfant ?",
  "Quel est le prénom de votre premier enseignant ?",
  "Quel est le nom de votre premier animal de compagnie ?",
  "Quel était ton jouet préféré quand tu étais enfant ?",
  "Quel est ton club de football préféré ?",
  "Quelle est ton équipe nationale préférée ?",
  "Quel pays rêves-tu de visiter ?",
  "Quel est ton joueur de football préféré ?",
  "Quel est ton plat préféré ?",
  "Quelle est ta voiture préférée ?",
  "Quelle voiture rêves-tu de posséder ?",
  "Quel prénom aimerais-tu donner à ton futur fils ?",
  "Quel prénom aimerais-tu donner à ta future fille ?"
];

function normalizeSecurityAnswer(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("fr");
}

async function initializeUserProfile() {
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id TEXT NOT NULL DEFAULT 'avatar-01'");
}

async function initializeSecurityQuestions() {
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question TEXT");
  await pgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_hash TEXT");
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS security_recovery_attempts (
      username_key TEXT NOT NULL,
      ip_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ,
      PRIMARY KEY (username_key, ip_key)
    )
  `);
}

const { analyzeSportApiMatches } = require("./algorithms/sportapi-odds-service");
const { fetchFixtures: fetchSportApiFixtures } = require("./algorithms/sportapi-fixtures-service");

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
  whatsappEnabled: "true",
  telegramEnabled: "true",
  whatsappGroupEnabled: "true",
  telegramGroupEnabled: "true",
  wave500Enabled: "true",
  wave1000Enabled: "true",
  orangeMoneyEnabled: "true",
  moovMoneyEnabled: "true",
  mtnMoneyEnabled: "true",
  tiktokEnabled: "true",
  facebookEnabled: "true",
  instagramEnabled: "true",
  sdriveLinkEnabled: "true",
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
    full_name: user.full_name || "",
    phone: user.phone || "",
    country: user.country || "",
    city: user.city || "",
    email: user.email || "",
    bio: user.bio || "",
    avatar_id: /^avatar-(0[1-9]|10)$/.test(String(user.avatar_id || "")) ? user.avatar_id : "avatar-01",
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
  : (() => {
      // Charger SQLite uniquement si PostgreSQL n'est pas configuré.
      const SQLiteStore = require("connect-sqlite3")(session);
      return new SQLiteStore({ db: "sessions.sqlite", dir: __dirname });
    })();

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
  const securityQuestion = String(req.body.security_question || "");
  const securityAnswer = normalizeSecurityAnswer(req.body.security_answer);
  const referralCode = String(req.body.referral_code || "")
    .trim()
    .toUpperCase();

  if (!username || password.length < 6) {
    return res.status(400).json({
      error: "Nom d'utilisateur et mot de passe valides requis (6 caractères minimum)."
    });
  }
  if (!SECURITY_QUESTIONS.includes(securityQuestion)) {
    return res.status(400).json({ error: "Choisissez une question secrète valide." });
  }
  if (securityAnswer.length < 2 || securityAnswer.length > 100) {
    return res.status(400).json({
      error: "La réponse secrète doit contenir entre 2 et 100 caractères."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let referrerId = null;
    if (referralCode) {
      let referrer = await client.query(
        `SELECT user_id FROM affiliate_profiles
         WHERE UPPER(BTRIM(referral_code)) = $1`,
        [referralCode]
      );

      if (referrer.rowCount === 0) {
        referrer = await client.query(
          `SELECT user_id FROM affiliate_referral_code_aliases
           WHERE UPPER(BTRIM(referral_code)) = $1`,
          [referralCode]
        );
      }

      if (referrer.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Ce code de parrainage est invalide."
        });
      }
      referrerId = Number(referrer.rows[0].user_id);
    }

    const result = await client.query(
      `INSERT INTO users(
         username, phone, password_hash, security_question, security_answer_hash
       )
       VALUES($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        username,
        "",
        bcrypt.hashSync(password, 12),
        securityQuestion,
        bcrypt.hashSync(securityAnswer, 12)
      ]
    );

    const userId = Number(result.rows[0].id);
    let profileCreated = false;

    for (let attempt = 0; attempt < 8 && !profileCreated; attempt++) {
      const ownReferralCode = `BAT-${Array.from(
        { length: 4 },
        () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(36)]
      ).join("")}`;

      const codeInUse = await client.query(
        `SELECT 1 FROM affiliate_profiles WHERE UPPER(BTRIM(referral_code)) = $1
         UNION ALL
         SELECT 1 FROM affiliate_referral_code_aliases WHERE UPPER(BTRIM(referral_code)) = $1
         LIMIT 1`,
        [ownReferralCode]
      );
      if (codeInUse.rowCount) continue;

      try {
        const profile = await client.query(
          `INSERT INTO affiliate_profiles(
             user_id, referral_code, referred_by_user_id
           )
           VALUES($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING user_id`,
          [userId, ownReferralCode, referrerId]
        );

        profileCreated = profile.rowCount === 1;
      } catch (error) {
        if (error.code !== "23505") throw error;
      }
    }

    if (!profileCreated) {
      throw new Error("Impossible de créer le profil de parrainage du nouveau compte.");
    }

    await client.query("COMMIT");

    const user = await pgGet(
      "SELECT * FROM users WHERE id=$1",
      [userId]
    );

    req.session.userId = userId;
    res.status(201).json({
      message: "Compte créé avec succès.",
      user: userView(user)
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    if (error && error.code === "23505") {
      return res.status(409).json({
        error: "Ce nom d'utilisateur existe déjà."
      });
    }

    console.error("register PostgreSQL:", error);
    res.status(500).json({ error: "Impossible de créer le compte." });
  } finally {
    client.release();
  }
});
app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  try {
    const idMatch = username.match(/^BATBOT-(\d+)$/i);
    const user = idMatch
      ? await pgGet("SELECT * FROM users WHERE id=$1", [idMatch[1]])
      : await pgGet("SELECT * FROM users WHERE username=$1", [username]);

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
      "SELECT id, disabled, security_question, security_answer_hash FROM users WHERE username=$1",
      [username]
    );

    if (!user || user.disabled) {
      return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
    }

    if (user.security_question && user.security_answer_hash) {
      return res.json({
        mode: "security_question",
        question: user.security_question,
        message: "Répondez à votre question secrète pour choisir un nouveau mot de passe."
      });
    }

    return res.json({
      mode: "contact_admin",
      message: "Aucune question secrète n’est enregistrée pour ce compte. Contactez l’administrateur sur WhatsApp pour récupérer votre accès."
    });
  } catch (error) {
    console.error("password-reset PostgreSQL:", error);
    res.status(500).json({ error: "Impossible d’enregistrer la récupération." });
  }
});

app.post("/api/password-reset/security", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const answer = normalizeSecurityAnswer(req.body.security_answer);
  const password = String(req.body.password || "");
  const confirmation = String(req.body.confirm_password || "");
  const ipKey = String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 100);
  const usernameKey = username.normalize("NFKC").toLocaleLowerCase("fr").slice(0, 100);

  if (!username || answer.length < 2 || answer.length > 100) {
    return res.status(400).json({ error: "Saisissez votre nom d'utilisateur et votre réponse secrète." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
  }
  if (password !== confirmation) {
    return res.status(400).json({ error: "Les deux mots de passe ne correspondent pas." });
  }

  try {
    const attempts = await pgGet(
      "SELECT attempts, locked_until FROM security_recovery_attempts WHERE username_key=$1 AND ip_key=$2",
      [usernameKey, ipKey]
    );
    if (attempts?.locked_until && new Date(attempts.locked_until) > new Date()) {
      return res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });
    }

    const user = await pgGet(
      "SELECT id, disabled, security_question, security_answer_hash FROM users WHERE username=$1",
      [username]
    );
    if (!user || user.disabled || !user.security_question || !user.security_answer_hash) {
      return res.status(400).json({ error: "Impossible de vérifier cette réponse. Vérifiez les informations ou contactez l'administrateur." });
    }

    const validAnswer = bcrypt.compareSync(answer, user.security_answer_hash);
    if (!validAnswer) {
      await pgQuery(`
        INSERT INTO security_recovery_attempts(username_key,ip_key,attempts,window_started_at,locked_until)
        VALUES($1,$2,1,NOW(),NULL)
        ON CONFLICT(username_key,ip_key) DO UPDATE SET
          attempts = CASE
            WHEN security_recovery_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN 1
            ELSE security_recovery_attempts.attempts + 1
          END,
          window_started_at = CASE
            WHEN security_recovery_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN NOW()
            ELSE security_recovery_attempts.window_started_at
          END,
          locked_until = CASE
            WHEN (CASE
              WHEN security_recovery_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN 1
              ELSE security_recovery_attempts.attempts + 1
            END) >= 5 THEN NOW() + INTERVAL '15 minutes'
            ELSE NULL
          END
      `, [usernameKey, ipKey]);
      return res.status(401).json({ error: "Réponse secrète incorrecte." });
    }

    await pgQuery(
      "UPDATE security_recovery_attempts SET attempts=0, window_started_at=NOW(), locked_until=NULL WHERE username_key=$1 AND ip_key=$2",
      [usernameKey, ipKey]
    );

    await pgQuery(`
      UPDATE users
      SET password_hash=$1, must_change_password=false,
          temporary_password_hash=NULL, temporary_password_expires_at=NULL
      WHERE id=$2
    `, [bcrypt.hashSync(password, 12), user.id]);

    await pgQuery(
      "UPDATE password_resets SET status='cancelled', resolved_at=NOW() WHERE user_id=$1 AND status='pending'",
      [user.id]
    );

    res.json({ message: "Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter." });
  } catch (error) {
    console.error("password-reset security PostgreSQL:", error);
    res.status(500).json({ error: "Impossible de réinitialiser le mot de passe pour le moment." });
  }
});

// Compatibilité avec les anciennes versions de l'interface.
app.post("/api/forgot-password", async (req, res) => {
  const username = String(req.body.username || "").trim();

  try {
    const user = await pgGet(
      "SELECT id, disabled, security_question, security_answer_hash FROM users WHERE username=$1",
      [username]
    );

    if (!user || user.disabled) {
      return res.status(404).json({ error: "Utilisateur introuvable avec ces informations." });
    }

    if (user.security_question && user.security_answer_hash) {
      return res.json({
        mode: "security_question",
        question: user.security_question,
        message: "Répondez à votre question secrète pour choisir un nouveau mot de passe."
      });
    }

    return res.json({
      mode: "contact_admin",
      message: "Aucune question secrète n’est enregistrée pour ce compte. Contactez l’administrateur sur WhatsApp pour récupérer votre accès."
    });
  } catch (error) {
    console.error("forgot-password PostgreSQL:", error);
    res.status(500).json({ error: "Impossible d’enregistrer la récupération." });
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

const ALLOWED_PROFILE_AVATARS = new Set(Array.from({ length: 10 }, (_, i) => `avatar-${String(i + 1).padStart(2, "0")}`));

app.put("/api/profile", requireUser, async (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  const country = String(req.body.country || "").trim();
  const city = String(req.body.city || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim();
  const bio = String(req.body.bio || "").trim();
  const avatarId = String(req.body.avatar_id || "avatar-01").trim();

  if (fullName.length > 100 || country.length > 80 || city.length > 80 ||
      email.length > 254 || phone.length > 30 || bio.length > 240) {
    return res.status(400).json({ error: "Un ou plusieurs champs dépassent la longueur autorisée." });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "L’adresse e-mail n’est pas valide." });
  }
  if (!ALLOWED_PROFILE_AVATARS.has(avatarId)) {
    return res.status(400).json({ error: "Cet avatar n’est pas autorisé." });
  }

  try {
    const result = await pgQuery(
      `UPDATE users
       SET full_name=$1, country=$2, city=$3, email=$4, phone=$5, bio=$6, avatar_id=$7
       WHERE id=$8 AND disabled=false`,
      [fullName, country, city, email, phone, bio, avatarId, req.session.userId]
    );
    if (!result.rowCount) return res.status(403).json({ error: "Compte indisponible." });
    const user = await pgGet("SELECT * FROM users WHERE id=$1", [req.session.userId]);
    return res.json({ message: "Profil enregistré.", user: userView(user) });
  } catch (error) {
    console.error("profile update PostgreSQL:", error);
    return res.status(500).json({ error: "Impossible d’enregistrer le profil pour le moment." });
  }
});

app.post("/api/profile/password", requireUser, async (req, res) => {
  const currentPassword = String(req.body.current_password || "");
  const password = String(req.body.password || "");
  const confirmation = String(req.body.confirm_password || "");
  if (password.length < 6) return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
  if (password !== confirmation) return res.status(400).json({ error: "Les deux nouveaux mots de passe ne correspondent pas." });
  if (currentPassword.length < 1) return res.status(400).json({ error: "Saisissez votre mot de passe actuel." });

  try {
    const user = await pgGet("SELECT * FROM users WHERE id=$1", [req.session.userId]);
    if (!user || user.disabled) return res.status(403).json({ error: "Compte indisponible." });
    if (user.must_change_password) return res.status(400).json({ error: "Terminez d’abord la procédure de changement de mot de passe temporaire." });
    if (!user.password_hash || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: "Le mot de passe actuel est incorrect." });
    }
    await pgQuery("UPDATE users SET password_hash=$1 WHERE id=$2", [bcrypt.hashSync(password, 12), user.id]);
    return res.json({ message: "Mot de passe modifié avec succès." });
  } catch (error) {
    console.error("profile password PostgreSQL:", error);
    return res.status(500).json({ error: "Impossible de modifier le mot de passe pour le moment." });
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
  const premiumAmounts = {
    "Premium 7 jours": 1000,
    "Premium 14 jours": 2000,
    "Premium 21 jours": 3000
  };

  if (!Object.prototype.hasOwnProperty.call(premiumAmounts, offer)) {
    return res.status(400).json({ error: "Choisissez une formule Premium disponible." });
  }
  if (!allowedOperators.includes(operator) || !Number.isInteger(amount) || amount !== premiumAmounts[offer] || !reference) {
    return res.status(400).json({ error: "Vérifiez le moyen de paiement, le montant exact de la formule et la référence de transaction." });
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
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '14 days'
    ORDER BY id DESC
  `, [req.session.userId]);
  res.json({ requests });
});

app.get("/api/admin/payment-requests", requireAdmin, async (req, res) => {
  const requests = await pgAll(`
    SELECT p.*, u.username, u.phone
    FROM payment_requests p
    LEFT JOIN users u ON u.id=p.user_id
    WHERE p.status='pending'
       OR p.created_at > CURRENT_TIMESTAMP - INTERVAL '14 days'
    ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END, p.id DESC
  `);
  res.json({ requests });
});

app.delete("/api/admin/payment-requests/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Identifiant de reçu invalide." });
  }

  try {
    const result = await pgQuery(
      "DELETE FROM payment_requests WHERE id=$1",
      [id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Reçu introuvable ou déjà supprimé." });
    }
    res.json({ message: "Reçu de paiement supprimé." });
  } catch (error) {
    console.error("BATBOT PAYMENT RECEIPT DELETE:", error.message);
    res.status(500).json({ error: "Impossible de supprimer ce reçu pour le moment." });
  }
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

    if (status === "accepted") {
      const offer = String(request.offer || "").trim();
      const premiumOffers = {
        "Premium 7 jours": { amount: 1000, days: 7 },
        "Premium 14 jours": { amount: 2000, days: 14 },
        "Premium 21 jours": { amount: 3000, days: 21 }
      };
      const expected = premiumOffers[offer];
      const amount = Number(request.amount);
      const operator = String(request.operator || "").trim();
      const reference = String(request.reference || "").trim();
      const allowedOperators = ["Orange Money", "MTN Money", "Moov Money", "Wave"];

      if (!expected || !Number.isInteger(amount) || amount !== expected.amount || !allowedOperators.includes(operator) || !reference) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Demande Premium invalide : formule, montant, moyen de paiement ou référence incorrect." });
      }

      const durationDays = expected.days;
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

      // Enregistre le paiement et sa commission dans la même transaction.
      await recordAffiliateConfirmedPayment(
        client,
        request,
        offer,
        amount,
        now.toISOString()
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


// Demande de retrait : réservation atomique des commissions disponibles.
app.post("/api/affiliate/withdrawals", requireUser, async (req, res) => {
  const commissionType = String(req.body.commission_type || "");
  const paymentMethod = String(req.body.payment_method || "");
  const paymentNumber = String(req.body.payment_number || "").trim();
  const accountId = String(req.body.batbot_account_id || "").trim();
  const amount = Number(req.body.amount);
  const allowedTypes = ["first_purchase_20", "renewal_10"];
  const allowedMethods = ["Wave", "Orange Money", "MTN Money", "Moov Money"];

  if (
    !allowedTypes.includes(commissionType) ||
    !allowedMethods.includes(paymentMethod) ||
    !Number.isSafeInteger(amount) ||
    amount < 3000 ||
    !/^[0-9+() .-]{8,24}$/.test(paymentNumber) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)
  ) {
    return res.status(400).json({
      error: "Informations de retrait invalides. Minimum : 3 000 FCFA."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const profile = await client.query(
      "SELECT user_id FROM affiliate_profiles WHERE user_id=$1 FOR UPDATE",
      [req.session.userId]
    );
    if (profile.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Profil de parrainage introuvable." });
    }

    const commissions = await client.query(
      `SELECT id, commission_amount
         FROM affiliate_commissions
        WHERE affiliate_user_id=$1
          AND commission_type=$2
          AND status='available'
        ORDER BY created_at, id
        FOR UPDATE`,
      [req.session.userId, commissionType]
    );

    let selected = [];
    let total = 0;
    for (const row of commissions.rows) {
      if (total + Number(row.commission_amount) > amount) continue;
      selected.push(row);
      total += Number(row.commission_amount);
      if (total === amount) break;
    }

    if (total !== amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Le solde disponible ne permet pas ce retrait exact."
      });
    }

    const withdrawal = await client.query(
      `INSERT INTO affiliate_withdrawals
         (affiliate_user_id, commission_type, amount, payment_method,
          payment_number, batbot_account_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id, amount, commission_type, payment_method, status, created_at`,
      [req.session.userId, commissionType, amount, paymentMethod, paymentNumber, accountId]
    );

    for (const row of selected) {
      const reserved = await client.query(
        `UPDATE affiliate_commissions
            SET status='reserved'
          WHERE id=$1 AND status='available'`,
        [row.id]
      );
      if (reserved.rowCount !== 1) {
        throw new Error("Une commission n'est plus disponible.");
      }

      await client.query(
        `INSERT INTO affiliate_withdrawal_commissions
           (withdrawal_id, commission_id, amount)
         VALUES ($1, $2, $3)`,
        [withdrawal.rows[0].id, row.id, row.commission_amount]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ withdrawal: withdrawal.rows[0] });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("BATBOT AFFILIATE WITHDRAWAL:", error.message);
    res.status(500).json({ error: "Impossible d'enregistrer la demande de retrait." });
  } finally {
    client.release();
  }
});

// Historique des retraits du membre connecté.
app.get("/api/affiliate/withdrawals/mine", requireUser, async (req, res) => {
  try {
    const withdrawals = await pgAll(
      `SELECT id, commission_type, amount, payment_method, payment_number, status,
              admin_note, payment_reference, created_at, resolved_at, paid_at
         FROM affiliate_withdrawals
        WHERE affiliate_user_id=$1
          AND created_at > CURRENT_TIMESTAMP - INTERVAL '14 days'
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.session.userId]
    );
    res.json({ withdrawals });
  } catch (error) {
    console.error("BATBOT AFFILIATE WITHDRAWALS:", error.message);
    res.status(500).json({ error: "Impossible de charger les retraits." });
  }
});

// Administration : liste des demandes, sans exposer les profils complets.
app.get("/api/admin/affiliate/withdrawals", requireAdmin, async (req, res) => {
  try {
    const withdrawals = await pgAll(
      `SELECT w.id, w.affiliate_user_id, u.username,
              w.commission_type, w.amount, w.payment_method,
              w.payment_number, w.batbot_account_id, w.status,
              w.admin_note, w.payment_reference, w.created_at,
              w.resolved_at, w.paid_at
         FROM affiliate_withdrawals w
         JOIN users u ON u.id=w.affiliate_user_id
        WHERE w.status IN ('pending','verifying','approved')
           OR w.created_at > CURRENT_TIMESTAMP - INTERVAL '14 days'
        ORDER BY CASE WHEN w.status IN ('pending','verifying','approved') THEN 0 ELSE 1 END,
                 w.created_at ASC
        LIMIT 300`
    );
    res.json({ withdrawals });
  } catch (error) {
    console.error("BATBOT ADMIN AFFILIATE WITHDRAWALS:", error.message);
    res.status(500).json({ error: "Impossible de charger les demandes." });
  }
});

// Administration : transitions de statut et paiement idempotent.
app.patch("/api/admin/affiliate/withdrawals/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");
  const note = String(req.body.admin_note || "").trim().slice(0, 1000);
  const reference = String(req.body.payment_reference || "").trim().slice(0, 200);
  const allowedStatuses = ["verifying", "approved", "paid", "rejected"];

  if (!Number.isSafeInteger(id) || id <= 0 || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: "Demande ou statut invalide." });
  }
  if (status === "paid" && !reference) {
    return res.status(400).json({ error: "La référence du paiement est obligatoire." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT * FROM affiliate_withdrawals WHERE id=$1 FOR UPDATE",
      [id]
    );
    const withdrawal = found.rows[0];

    if (!withdrawal) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Demande de retrait introuvable." });
    }
    if (["paid", "rejected"].includes(withdrawal.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cette demande est déjà terminée." });
    }

    // Un paiement réel n'est autorisé qu'après approbation explicite.
    if (status === "paid" && withdrawal.status !== "approved") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "La demande doit être approuvée avant d'être marquée comme payée."
      });
    }

    const allowedTransitions = {
      pending: ["verifying", "approved", "rejected"],
      verifying: ["verifying", "approved", "rejected"],
      approved: ["approved", "paid", "rejected"]
    };

    if (!(allowedTransitions[withdrawal.status] || []).includes(status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Transition de statut non autorisée."
      });
    }

    if (status === "rejected") {
      const linked = await client.query(
        `SELECT commission_id FROM affiliate_withdrawal_commissions
          WHERE withdrawal_id=$1 AND released_at IS NULL
          FOR UPDATE`,
        [id]
      );
      for (const row of linked.rows) {
        await client.query(
          `UPDATE affiliate_commissions SET status='available'
            WHERE id=$1 AND status='reserved'`,
          [row.commission_id]
        );
      }
      await client.query(
        `UPDATE affiliate_withdrawal_commissions
            SET released_at=CURRENT_TIMESTAMP
          WHERE withdrawal_id=$1 AND released_at IS NULL`,
        [id]
      );
    }

    if (status === "paid") {
      const linked = await client.query(
        `SELECT wc.commission_id, wc.amount, c.status
           FROM affiliate_withdrawal_commissions wc
           JOIN affiliate_commissions c ON c.id=wc.commission_id
          WHERE wc.withdrawal_id=$1 AND wc.released_at IS NULL
          FOR UPDATE OF c`,
        [id]
      );
      if (!linked.rowCount || linked.rows.some(row => row.status !== "reserved")) {
        throw new Error("Les commissions réservées ne correspondent plus à cette demande.");
      }
      const total = linked.rows.reduce((sum, row) => sum + Number(row.amount), 0);
      if (total !== Number(withdrawal.amount)) {
        throw new Error("Le total réservé ne correspond pas au montant demandé.");
      }

      for (const row of linked.rows) {
        const paid = await client.query(
          `UPDATE affiliate_commissions SET status='paid', paid_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND status='reserved'`,
          [row.commission_id]
        );
        if (paid.rowCount !== 1) {
          throw new Error("Une commission a déjà été traitée.");
        }
      }
    }

    const updated = await client.query(
      `UPDATE affiliate_withdrawals
          SET status=$1, admin_note=$2, payment_reference=$3,
              resolved_at=CURRENT_TIMESTAMP,
              paid_at=CASE WHEN $1='paid' THEN CURRENT_TIMESTAMP ELSE paid_at END
        WHERE id=$4 AND status NOT IN ('paid','rejected')
        RETURNING id, status, amount, resolved_at, paid_at`,
      [status, note, status === "paid" ? reference : withdrawal.payment_reference, id]
    );
    if (updated.rowCount !== 1) {
      throw new Error("La demande a été traitée entre-temps.");
    }

    await client.query("COMMIT");
    res.json({ withdrawal: updated.rows[0] });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("BATBOT ADMIN AFFILIATE WITHDRAWAL UPDATE:", error.message);
    res.status(409).json({ error: error.message || "Impossible de traiter ce retrait." });
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

async function validateFootballTeamForAI(teamName, teamId = "") {
  const name = String(teamName || "").trim();
  const id = String(teamId || "").trim();
  if (!name && !id) return false;

  const cacheKey = (id ? `id:${id}` : `name:${name}`).toLowerCase();
  const cached = footballTeamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;

  if (name && typeof validateLocalFootballTeam === "function" && validateLocalFootballTeam(name)) {
    footballTeamCache.set(cacheKey, { valid: true, expiresAt: Date.now() + 15 * 60 * 1000 });
    return true;
  }

  // Ne jamais fabriquer un identifiant d'équipe à partir de son nom.
  // L'identifiant fourni doit provenir d'une fixture SportAPI.ai réelle.
  if (id && /^[a-z0-9][a-z0-9_-]{0,199}$/i.test(id)) {
    footballTeamCache.set(cacheKey, { valid: true, expiresAt: Date.now() + 15 * 60 * 1000 });
    return true;
  }

  footballTeamCache.set(cacheKey, { valid: false, expiresAt: Date.now() + 15 * 60 * 1000 });
  return false;
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
// n'est effectuée lors de la publication d'un pronostic membre. Les données
// football sont fournies par SportAPI.ai dans les routes dédiées.
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
  // obligatoire. L'IA peut toujours valider une équipe par son ID SportAPI.ai.
  // Cela évite qu'un déploiement incomplet
  // empêche tout le serveur de démarrer.
  LOCAL_FOOTBALL_TEAMS = [];
  console.warn("CATALOGUE ÉQUIPES LOCALES indisponible:", error.message);
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
  const publicServiceValue = key => String(s[key + "Enabled"] ?? "true").toLowerCase() === "false" ? "" : (s[key] || "");
  res.json({
    whatsapp: publicServiceValue("whatsapp"), telegram: publicServiceValue("telegram"),
    whatsappGroup: publicServiceValue("whatsappGroup"), telegramGroup: publicServiceValue("telegramGroup"),
    tiktok: publicServiceValue("tiktok"), facebook: publicServiceValue("facebook"), instagram: publicServiceValue("instagram"),
    wave500: publicServiceValue("wave500"), wave1000: publicServiceValue("wave1000"), wavePromo: s.wavePromo,
    promoFee: s.promoFee,
    sdriveLink: publicServiceValue("sdriveLink"), sdriveInviteMessage: s.sdriveInviteMessage || "",
    whatsappEnabled: String(s.whatsappEnabled ?? "true").toLowerCase() !== "false",
    telegramEnabled: String(s.telegramEnabled ?? "true").toLowerCase() !== "false",
    whatsappGroupEnabled: String(s.whatsappGroupEnabled ?? "true").toLowerCase() !== "false",
    telegramGroupEnabled: String(s.telegramGroupEnabled ?? "true").toLowerCase() !== "false",
    wave500Enabled: String(s.wave500Enabled ?? "true").toLowerCase() !== "false",
    wave1000Enabled: String(s.wave1000Enabled ?? "true").toLowerCase() !== "false",
    orangeMoneyEnabled: String(s.orangeMoneyEnabled ?? "true").toLowerCase() !== "false",
    moovMoneyEnabled: String(s.moovMoneyEnabled ?? "true").toLowerCase() !== "false",
    mtnMoneyEnabled: String(s.mtnMoneyEnabled ?? "true").toLowerCase() !== "false",
    tiktokEnabled: String(s.tiktokEnabled ?? "true").toLowerCase() !== "false",
    facebookEnabled: String(s.facebookEnabled ?? "true").toLowerCase() !== "false",
    instagramEnabled: String(s.instagramEnabled ?? "true").toLowerCase() !== "false",
    sdriveLinkEnabled: String(s.sdriveLinkEnabled ?? "true").toLowerCase() !== "false",
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
  const enabledKey = key + "Enabled";
  if (String(settings[enabledKey] ?? "true").toLowerCase() === "false") return res.status(404).json({ error: "Service désactivé par l’administrateur." });
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
    "whatsappEnabled", "telegramEnabled", "whatsappGroupEnabled", "telegramGroupEnabled", "wave500Enabled", "wave1000Enabled", "orangeMoneyEnabled", "moovMoneyEnabled", "mtnMoneyEnabled", "tiktokEnabled", "facebookEnabled", "instagramEnabled", "sdriveLinkEnabled",
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

    // Refuser les fixtures dont le statut ne permet pas une analyse.
    // Les analyses manuelles sans fixture restent autorisées.
    const allowedFixtureStatuses = new Set([
      "NS", "SCHEDULED", "NOT_STARTED", "TIMED", "UPCOMING", "FIXTURE",
      "LIVE", "1H", "2H", "HT", "ET", "IN_PLAY", "IN_PROGRESS",
      "FIRST_HALF", "SECOND_HALF", "HALF_TIME", "HALFTIME",
      "EXTRA_TIME", "PENALTIES", "PAUSED"
    ]);

    for (const match of matches) {
      if (match?.fixture == null) continue;

      const fixture = match.fixture;
      const rawStatus =
        fixture?.fixture?.status?.short ||
        fixture?.fixture?.status?.long ||
        fixture?.status?.short ||
        fixture?.status?.long ||
        (typeof fixture?.status === "string" ? fixture.status : "") ||
        fixture?.status_code ||
        fixture?.state ||
        "";

      const status = String(rawStatus)
        .trim()
        .toUpperCase()
        .replaceAll(" ", "_")
        .replaceAll("-", "_")
        .replaceAll(".", "_");

      if (!allowedFixtureStatuses.has(status)) {
        return res.status(400).json({
          ok: false,
          error: "Analyse refusée : statut du match inconnu ou non autorisé.",
          status: status || "UNKNOWN"
        });
      }
    }

    const validFixtures = matches
      .map(item => item?.fixture)
      .filter(fixture => fixture?.teams?.home?.id && fixture?.teams?.away?.id);

    if (!validFixtures.length) {
      return res.status(400).json({
        ok: false,
        source: "SportAPI.ai",
        error: "Sélectionnez un match proposé par SportAPI.ai avec les identifiants réels des deux équipes. Une saisie manuelle seule ne permet pas de récupérer un historique fiable."
      });
    }

    const analysis = await analyzeSportApiMatches(validFixtures);
    // Conserver chaque analyse exploitable comme un événement historique distinct.
    for (const item of (Array.isArray(analysis.matches) ? analysis.matches : [])) {
      const model = item?.model || {};
      const fixture = item?.fixture || {};
      const id = fixture?.fixture?.id ?? fixture?.id;
      const rawDate = fixture?.fixture?.date ?? fixture?.date;
      const date = typeof rawDate === "string" ? rawDate.slice(0, 10) : "";
      const home = String(fixture?.teams?.home?.name || item?.homeTeam?.name || "").trim();
      const away = String(fixture?.teams?.away?.name || item?.awayTeam?.name || "").trim();
      const pick = String(
        model?.recommendationCode || item?.recommendationCode || ""
      ).trim().toUpperCase();
      const allowedPicks = new Set([
        "1", "X", "2", "1X", "X2", "12",
        "OVER15", "OVER25", "OVER35", "UNDER25", "UNDER35",
        "BTTS_YES", "BTTS_NO"
      ]);
      if (item?.ready !== true || item?.sufficientData !== true ||
          model?.ready !== true || model?.sufficientData !== true ||
          !allowedPicks.has(pick) || id == null ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) || !home || !away) continue;
      const historyClient = await pool.connect();
      try {
        await historyClient.query("BEGIN");
        const historyKey = [
          "ai_prediction_history",
          req.session.userId,
          String(id),
          date,
          pick
        ].join(":");
        await historyClient.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [historyKey]
        );
        await historyClient.query(
          `INSERT INTO ai_prediction_history
            (user_id, fixture_id, fixture_date, home_team, away_team, league_name, main_pick)
           SELECT $1,$2,$3::date,$4,$5,$6,$7
           WHERE NOT EXISTS (
             SELECT 1
             FROM ai_prediction_history
             WHERE user_id=$1
               AND fixture_id=$2
               AND fixture_date=$3::date
               AND main_pick=$7
           )`,
          [req.session.userId, String(id), date, home, away, String(fixture?.league?.name || ""), pick]
        );
        await historyClient.query("COMMIT");
      } catch (historyError) {
        try {
          await historyClient.query("ROLLBACK");
        } catch (_) {}
        throw historyError;
      } finally {
        historyClient.release();
      }
    }
    return res.json({ ok: true, source: "SportAPI.ai", ...analysis });
  } catch (error) {
    console.error("SportAPI.ai odds analysis:", error.message);

    return res.status(502).json({
      ok: false,
      source: "SportAPI.ai",
      error: "Impossible de calculer l'analyse statistique des cotes.",
      details: error.message
    });
  }
});


app.get("/api/football/ai-history", requireUser, async (req, res) => {
  try {
    console.log("BATBOT_HISTORY_STEP: lecture_pending");
    const pending = await pgAll(
      `SELECT id, fixture_id, fixture_date FROM ai_prediction_history
       WHERE user_id=$1 AND status='pending' ORDER BY fixture_date ASC LIMIT 200`,
      [req.session.userId]
    );
    const dateOf = value => value instanceof Date
      ? value.toISOString().slice(0,10) : String(value).slice(0,10);
    const dates = [...new Set(pending.map(r => dateOf(r.fixture_date))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
    for (const date of dates) {
      let fresh;
      try { fresh = await fetchSportApiFixtures(date); }
      catch (error) {
        console.warn("BATBOT historique : résultat non vérifié pour", date, error.message);
        continue;
      }
      const fixtures = Array.isArray(fresh?.fixtures) ? fresh.fixtures : [];
      for (const row of pending) {
        if (dateOf(row.fixture_date) !== date) continue;
        const match = fixtures.find(f => String(f?.fixture?.id ?? "") === String(row.fixture_id));
        const status = String(match?.fixture?.status?.short || "").toUpperCase();
        const home = match?.goals?.home, away = match?.goals?.away;
        if (status !== "FT" || !Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) continue;
        console.log("BATBOT_HISTORY_STEP: mise_a_jour_scores");
        await pgQuery(
          `UPDATE ai_prediction_history SET final_home_score=$1::INTEGER, final_away_score=$2::INTEGER,
           status=CASE
             WHEN (main_pick='1' AND $1::INTEGER>$2::INTEGER)
               OR (main_pick='X' AND $1::INTEGER=$2::INTEGER)
               OR (main_pick='2' AND $1::INTEGER<$2::INTEGER)
               OR (main_pick='1X' AND $1::INTEGER>=$2::INTEGER)
               OR (main_pick='X2' AND $1::INTEGER<=$2::INTEGER)
               OR (main_pick='12' AND $1::INTEGER<>$2::INTEGER)
               OR (main_pick='OVER15' AND ($1::INTEGER+$2::INTEGER)>=2)
               OR (main_pick='OVER25' AND ($1::INTEGER+$2::INTEGER)>=3)
               OR (main_pick='OVER35' AND ($1::INTEGER+$2::INTEGER)>=4)
               OR (main_pick='UNDER25' AND ($1::INTEGER+$2::INTEGER)<=2)
               OR (main_pick='UNDER35' AND ($1::INTEGER+$2::INTEGER)<=3)
               OR (main_pick='BTTS_YES' AND $1::INTEGER>=1 AND $2::INTEGER>=1)
               OR (main_pick='BTTS_NO' AND ($1::INTEGER=0 OR $2::INTEGER=0))
             THEN 'validated' ELSE 'not_validated' END,
           settled_at=NOW()
           WHERE id=$3 AND user_id=$4 AND status='pending'`,
          [home, away, row.id, req.session.userId]
        );
      }
    }
    console.log("BATBOT_HISTORY_STEP: lecture_finale");
    const history = await pgAll(
      `SELECT id, fixture_id, fixture_date, home_team, away_team, league_name, main_pick,
       status, final_home_score, final_away_score, created_at, settled_at
       FROM (
         SELECT DISTINCT ON (fixture_id, fixture_date, main_pick)
           id, fixture_id, fixture_date, home_team, away_team, league_name, main_pick,
           status, final_home_score, final_away_score, created_at, settled_at
         FROM ai_prediction_history
         WHERE user_id=$1
         ORDER BY fixture_id, fixture_date, main_pick,
           (status <> 'pending') DESC, created_at ASC, id ASC
       ) AS deduplicated
       ORDER BY created_at DESC LIMIT 100`,
      [req.session.userId]
    );
    return res.json({ok:true, history});
  } catch (error) {
    console.error("BATBOT_HISTORY_ERROR:", error.message, error.code || "NO_SQL_CODE", error.position || "NO_SQL_POSITION");
    return res.status(500).json({ok:false,error:"Impossible de charger l'historique des pronostics."});
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
  const compactEvidence = evidence ? JSON.stringify(evidence).slice(0, 42000) : "Aucune donnée statistique SportAPI.ai supplémentaire n’a été fournie.";
  const modelInstruction = models.length ? `\nMODÈLE STATISTIQUE BATBOT (à respecter exactement pour les pourcentages) :\n${JSON.stringify(models)}\nLes valeurs 1/X/2 et les probabilités d’options fournies par ce modèle sont calculées à partir des données SportAPI.ai disponibles. Tu ne dois pas les inventer ni les modifier. Tu peux seulement expliquer leur lecture et choisir une recommandation cohérente.` : "";
  const prompt = `Tu es BatBot IA, assistant d’analyse football. Réponds uniquement avec un JSON valide, sans introduction, sans Markdown et sans texte supplémentaire.

Matchs à analyser :
${matches.join("\n")}

DONNÉES SPORTIVES RÉELLES DISPONIBLES (SportAPI.ai) :
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

  const systemInstruction = "Retourne uniquement le JSON demandé en français. Utilise exclusivement les données SportAPI.ai et le modèle statistique fournis. Ne présente jamais une estimation comme une certitude.";

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


function currentAbidjanDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}


app.get("/api/football/access", requireUser, async (_req, res) => {
  return res.json({ ok: true, source: "SportAPI.ai", access: true });
});


const sportApiFixturesCache = new Map();
const sportApiFixturesInFlight = new Map();
const SPORTAPI_FIXTURES_CACHE_TTL = 30 * 1000;
let sportApiPersistentCacheReady = false;


async function initializeAiPredictionHistory() {
  await pgQuery(`CREATE TABLE IF NOT EXISTS ai_prediction_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL,
    fixture_date DATE NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    league_name TEXT NOT NULL DEFAULT '',
    main_pick TEXT NOT NULL CHECK (main_pick IN ('1','X','2')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','validated','not_validated')),
    final_home_score INTEGER,
    final_away_score INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMPTZ,
    source TEXT NOT NULL DEFAULT 'SportAPI.ai'
  )`);
  await pgQuery(`
    DO $$
    DECLARE item RECORD;
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ai_prediction_history'::regclass
          AND conname = 'ai_prediction_history_main_pick_all_markets_check'
      ) THEN
        FOR item IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'ai_prediction_history'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%main_pick%'
        LOOP
          EXECUTE format(
            'ALTER TABLE ai_prediction_history DROP CONSTRAINT %I',
            item.conname
          );
        END LOOP;

        ALTER TABLE ai_prediction_history
          ADD CONSTRAINT ai_prediction_history_main_pick_all_markets_check
          CHECK (main_pick IN (
            '1','X','2','1X','X2','12',
            'OVER15','OVER25','OVER35','UNDER25','UNDER35',
            'BTTS_YES','BTTS_NO'
          ));
      END IF;
    END $$;
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS ai_prediction_history_user_created_idx
    ON ai_prediction_history (user_id, created_at DESC)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS ai_prediction_history_pending_idx
    ON ai_prediction_history (fixture_id, fixture_date) WHERE status='pending'`);
}

async function initializeSportApiFixturesCache() {
  try {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS sportapi_fixtures_cache (
        fixture_date DATE PRIMARY KEY,
        fixtures JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    sportApiPersistentCacheReady = true;
    console.log("BatBot: cache PostgreSQL SportAPI.ai prêt.");
  } catch (error) {
    sportApiPersistentCacheReady = false;
    console.error(
      "BatBot: cache PostgreSQL indisponible, cache mémoire conservé:",
      error.message
    );
  }
}

function filterSportApiFixtures(value, statusFilter, cached) {
  const statusMap = { live: "LIVE", finished: "FT", upcoming: "NS" };
  const requiredStatus = statusMap[statusFilter];
  const allFixtures = Array.isArray(value.fixtures) ? value.fixtures : [];
  const fixtures = requiredStatus
    ? allFixtures.filter(item => item?.fixture?.status?.short === requiredStatus)
    : allFixtures;

  return {
    source: "SportAPI.ai",
    date: value.date,
    count: fixtures.length,
    updated: value.updated,
    cached: Boolean(cached),
    stale: Boolean(value.stale),
    fixtures
  };
}

async function loadSportApiFixturesByDate(date) {
  const memory = sportApiFixturesCache.get(date);
  if (memory && memory.expiresAt > Date.now()) {
    return { ...memory.value, cached: true };
  }

  const pending = sportApiFixturesInFlight.get(date);
  if (pending) {
    const value = await pending;
    return { ...value, cached: true };
  }

  const request = (async () => {
    let persisted = null;

    if (sportApiPersistentCacheReady) {
      try {
        persisted = await pgGet(
          "SELECT fixtures, fetched_at FROM sportapi_fixtures_cache WHERE fixture_date=$1::date",
          [date]
        );
      } catch (error) {
        console.error("BatBot: lecture du cache SportAPI PostgreSQL:", error.message);
      }
    }

    if (persisted && Array.isArray(persisted.fixtures)) {
      const updated = new Date(persisted.fetched_at).toISOString();
      const age = Date.now() - new Date(persisted.fetched_at).getTime();
      const value = {
        source: "SportAPI.ai",
        date,
        updated,
        fixtures: persisted.fixtures,
        stale: false
      };

      if (age >= 0 && age < SPORTAPI_FIXTURES_CACHE_TTL) {
        sportApiFixturesCache.set(date, {
          value,
          expiresAt: Date.now() + SPORTAPI_FIXTURES_CACHE_TTL
        });
        return { ...value, cached: true };
      }
    }

    try {
      const apiResult = await fetchSportApiFixtures(date);
      if (!Array.isArray(apiResult?.fixtures)) {
        throw new Error("Réponse SportAPI.ai sans liste valide de matchs.");
      }

      const value = {
        source: "SportAPI.ai",
        date,
        updated: new Date().toISOString(),
        fixtures: apiResult.fixtures,
        stale: false
      };

      sportApiFixturesCache.set(date, {
        value,
        expiresAt: Date.now() + SPORTAPI_FIXTURES_CACHE_TTL
      });

      if (sportApiPersistentCacheReady) {
        try {
          await pgQuery(
            `INSERT INTO sportapi_fixtures_cache (fixture_date, fixtures, fetched_at)
             VALUES ($1::date, $2::jsonb, NOW())
             ON CONFLICT (fixture_date)
             DO UPDATE SET fixtures=EXCLUDED.fixtures, fetched_at=NOW()`,
            [date, JSON.stringify(value.fixtures)]
          );
        } catch (error) {
          console.error("BatBot: écriture du cache SportAPI PostgreSQL:", error.message);
        }
      }

      return { ...value, cached: false };
    } catch (error) {
      if (persisted && Array.isArray(persisted.fixtures)) {
        return {
          source: "SportAPI.ai",
          date,
          updated: new Date(persisted.fetched_at).toISOString(),
          fixtures: persisted.fixtures,
          cached: true,
          stale: true,
          refreshError: error
        };
      }
      throw error;
    }
  })();

  sportApiFixturesInFlight.set(date, request);
  try {
    return await request;
  } finally {
    if (sportApiFixturesInFlight.get(date) === request) {
      sportApiFixturesInFlight.delete(date);
    }
  }
}

async function getSportApiFixturesCached(date, statusFilter = "") {
  const value = await loadSportApiFixturesByDate(date);

  // Ne jamais présenter une ancienne copie comme des matchs actuellement en direct.
  if (statusFilter === "live" && value.stale) {
    throw value.refreshError || new Error("Les données des matchs en direct sont périmées.");
  }

  return filterSportApiFixtures(value, statusFilter, value.cached);
}

app.get("/api/football/fixtures", requireUser, async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : currentAbidjanDate();

    const requestedStatus = String(req.query.status || "").trim();
    const statusFilter = ["live", "finished", "upcoming"].includes(requestedStatus)
      ? requestedStatus
      : "";

    const data = await getSportApiFixturesCached(date, statusFilter);

    return res.json({
      ok: true,
      source: data.source,
      checked_date: date,
      results_count: data.fixtures.length,
      updated: data.updated,
      cached: data.cached,
      stale: Boolean(data.stale),
      response: data.fixtures
    });
  } catch (error) {
    console.error("SportAPI.ai fixtures:", error.message);
    return res.status(error.status || 502).json({
      ok: false,
      error: "Impossible de récupérer les matchs SportAPI.ai."
    });
  }
});

app.get("/api/football/live", requireUser, async (req, res) => {
  try {
    const date = currentAbidjanDate();
    const data = await getSportApiFixturesCached(date, "live");

    return res.json({
      ok: true,
      source: data.source,
      live: true,
      checked_date: date,
      results_count: data.fixtures.length,
      updated: data.updated,
      cached: data.cached,
      stale: Boolean(data.stale),
      response: data.fixtures
    });
  } catch (error) {
    console.error("SportAPI.ai live:", error.message);
    return res.status(error.status || 502).json({
      ok: false,
      error: "Impossible de récupérer les matchs en direct SportAPI.ai."
    });
  }
});

app.get("/api/football/status", requireUser, async (_req, res) => {
  res.json({
    ok: true,
    source: "SportAPI.ai",
    api_key_required: true,
    message: "SportAPI.ai est l’unique source de données football de BATBOT."
  });
});


// Logos SportAPI.ai : proxy authentifié, sans exposer la clé au navigateur.
const sportApiTeamLogoCache = new Map();
const SPORTAPI_TEAM_LOGO_TTL = 6 * 60 * 60 * 1000;

app.get("/api/football/teams/:teamId/logo", requireUser, async (req, res) => {
  const teamId = String(req.params.teamId || "");

  if (!/^\d{1,10}$/.test(teamId) || Number(teamId) < 1) {
    return res.status(400).json({ ok: false, error: "Identifiant de club invalide." });
  }

  const now = Date.now();
  const cached = sportApiTeamLogoCache.get(teamId);

  if (cached && cached.expiresAt > now) {
    res.set("Content-Type", cached.contentType);
    res.set("Cache-Control", "private, max-age=21600");
    res.set("X-Content-Type-Options", "nosniff");
    return res.status(200).send(cached.body);
  }

  const apiKey = process.env.SPORTAPI_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: "Service de logos indisponible." });
  }

  try {
    const upstream = await fetch(
      `https://sportapi.ai/api/teams/${teamId}/logo`,
      {
        headers: {
          "X-Api-Key": apiKey,
          "Accept": "image/png,image/svg+xml,image/webp,image/jpeg"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!upstream.ok) {
      return res.status(upstream.status === 404 ? 404 : 502).json({
        ok: false,
        error: "Logo indisponible auprès de SportAPI.ai."
      });
    }

    const contentType = String(upstream.headers.get("content-type") || "")
      .split(";")[0].trim().toLowerCase();

    const allowedTypes = new Set([
      "image/png",
      "image/svg+xml",
      "image/webp",
      "image/jpeg"
    ]);

    if (!allowedTypes.has(contentType)) {
      return res.status(502).json({
        ok: false,
        error: "Format de logo non pris en charge."
      });
    }

    const body = Buffer.from(await upstream.arrayBuffer());

    if (!body.length || body.length > 2 * 1024 * 1024) {
      return res.status(502).json({
        ok: false,
        error: "Taille de logo invalide."
      });
    }

    // Évite une croissance illimitée du cache en mémoire.
    if (sportApiTeamLogoCache.size >= 500) {
      const firstKey = sportApiTeamLogoCache.keys().next().value;
      if (firstKey !== undefined) sportApiTeamLogoCache.delete(firstKey);
    }

    sportApiTeamLogoCache.set(teamId, {
      body,
      contentType,
      expiresAt: Date.now() + SPORTAPI_TEAM_LOGO_TTL
    });

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "private, max-age=21600");
    res.set("X-Content-Type-Options", "nosniff");
    return res.status(200).send(body);
  } catch (error) {
    console.error("Logo SportAPI.ai indisponible:", error.message);
    return res.status(502).json({
      ok: false,
      error: "Impossible de récupérer le logo du club."
    });
  }
});

// Toujours revalider la page et le service worker pour éviter une ancienne interface.
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/sw.js", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html") || filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
}));





// API membre : informations et soldes du programme de parrainage.
app.get("/api/affiliate/me", requireUser, async (req, res) => {
  try {
    const profile = await pgGet(
      `SELECT referral_code, qualification_window_started_at,
              renewal_eligible_until
         FROM affiliate_profiles
        WHERE user_id = $1`,
      [req.session.userId]
    );

    if (!profile) {
      return res.status(404).json({
        error: "Profil de parrainage indisponible."
      });
    }

    const balances = await pgAll(
      `SELECT commission_type, COALESCE(SUM(commission_amount), 0)::int AS earned,
              COALESCE(SUM(commission_amount) FILTER (WHERE status = 'available'), 0)::int AS available,
              COALESCE(SUM(commission_amount) FILTER (WHERE status = 'reserved'), 0)::int AS reserved,
              COALESCE(SUM(commission_amount) FILTER (WHERE status = 'paid'), 0)::int AS paid
         FROM affiliate_commissions
        WHERE affiliate_user_id = $1
        GROUP BY commission_type`,
      [req.session.userId]
    );

    const baseUrl = "https://batbot.pro";
    res.json({
      referral_code: profile.referral_code,
      referral_link: `${baseUrl}/?ref=${encodeURIComponent(profile.referral_code)}`,
      qualification_window_started_at: profile.qualification_window_started_at,
      renewal_eligible_until: profile.renewal_eligible_until,
      withdrawal_minimum: 3000,
      balances
    });
  } catch (error) {
    console.error("BATBOT AFFILIATE PROFILE:", error.message);
    res.status(500).json({
      error: "Impossible de charger les informations de parrainage."
    });
  }
});

// API membre : liste limitée aux filleuls directs du compte connecté.
app.get("/api/affiliate/referrals", requireUser, async (req, res) => {
  try {
    const referrals = await pgAll(
      `SELECT u.id,
              u.username,
              ap.created_at AS joined_at,
              EXISTS (
                SELECT 1
                  FROM affiliate_payment_events e
                 WHERE e.user_id = u.id
              ) AS has_confirmed_payment,
              (
                SELECT COUNT(*)::int
                  FROM affiliate_commissions c
                 WHERE c.referred_user_id = u.id
                   AND c.affiliate_user_id = $1
                   AND c.commission_type = 'first_purchase_20'
              ) AS first_commission_recorded
         FROM affiliate_profiles ap
         JOIN users u ON u.id = ap.user_id
        WHERE ap.referred_by_user_id = $1
        ORDER BY ap.created_at DESC
        LIMIT 200`,
      [req.session.userId]
    );

    res.json({ referrals });
  } catch (error) {
    console.error("BATBOT AFFILIATE REFERRALS:", error.message);
    res.status(500).json({
      error: "Impossible de charger la liste des filleuls."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function recordAffiliateConfirmedPayment(client, request, offer, amount, confirmedAt) {
  const payment = await client.query(
    `INSERT INTO affiliate_payment_events
       (payment_request_id, user_id, offer, amount, confirmed_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (payment_request_id) DO NOTHING
     RETURNING id`,
    [request.id, request.user_id, offer, amount, confirmedAt]
  );

  if (payment.rowCount !== 1) {
    throw new Error("Ce paiement possède déjà un événement d'affiliation.");
  }

  const paymentEventId = payment.rows[0].id;

  const referral = await client.query(
    `SELECT referred_by_user_id
       FROM affiliate_profiles
      WHERE user_id = $1
      FOR UPDATE`,
    [request.user_id]
  );

  const affiliateUserId = referral.rows[0]?.referred_by_user_id;
  if (!affiliateUserId) {
    return { paymentEventId, commissionType: null, commissionAmount: 0 };
  }

  // Verrouille le profil du parrain pour traiter ses qualifications en série.
  const affiliateResult = await client.query(
    `SELECT qualification_window_started_at, renewal_eligible_until
       FROM affiliate_profiles
      WHERE user_id = $1
      FOR UPDATE`,
    [affiliateUserId]
  );

  if (affiliateResult.rowCount !== 1) {
    throw new Error("Profil de parrain introuvable.");
  }

  const affiliateProfile = affiliateResult.rows[0];
  const paidAt = new Date(confirmedAt);
  let windowStart = affiliateProfile.qualification_window_started_at
    ? new Date(affiliateProfile.qualification_window_started_at)
    : null;

  // Une fenêtre de qualification dure 72 heures.
  if (!windowStart || paidAt.getTime() > windowStart.getTime() + 72 * 60 * 60 * 1000) {
    windowStart = paidAt;
    await client.query(
      `UPDATE affiliate_profiles
          SET qualification_window_started_at = $2
        WHERE user_id = $1`,
      [affiliateUserId, paidAt]
    );
  }

  const qualifiedReferrals = await client.query(
    `SELECT COUNT(DISTINCT e.user_id)::int AS total
       FROM affiliate_payment_events e
       JOIN affiliate_profiles referred_profile
         ON referred_profile.user_id = e.user_id
      WHERE referred_profile.referred_by_user_id = $1
        AND e.confirmed_at >= $2
        AND e.confirmed_at <= ($2::timestamptz + INTERVAL '72 hours')`,
    [affiliateUserId, windowStart]
  );

  const eligibleUntil = affiliateProfile.renewal_eligible_until
    ? new Date(affiliateProfile.renewal_eligible_until)
    : null;

  // La qualification est accordée ou renouvelée uniquement si elle est expirée.
  if (
    qualifiedReferrals.rows[0].total >= 10 &&
    (!eligibleUntil || eligibleUntil <= paidAt)
  ) {
    await client.query(
      `UPDATE affiliate_profiles
          SET renewal_eligible_until = $2::timestamptz + INTERVAL '30 days'
        WHERE user_id = $1`,
      [affiliateUserId, paidAt]
    );
  }

  const previousFirstPurchase = await client.query(
    `SELECT id
       FROM affiliate_commissions
      WHERE referred_user_id = $1
        AND commission_type = 'first_purchase_20'
      LIMIT 1`,
    [request.user_id]
  );

  let commissionType = null;
  let commissionRate = 0;

  if (previousFirstPurchase.rowCount === 0) {
    commissionType = "first_purchase_20";
    commissionRate = 0.20;
  } else {
    const currentEligibility = await client.query(
      `SELECT renewal_eligible_until
         FROM affiliate_profiles
        WHERE user_id = $1`,
      [affiliateUserId]
    );

    const currentEligibleUntil = currentEligibility.rows[0]?.renewal_eligible_until;
    if (currentEligibleUntil && new Date(currentEligibleUntil) > paidAt) {
      commissionType = "renewal_10";
      commissionRate = 0.10;
    }
  }

  if (!commissionType) {
    return { paymentEventId, commissionType: null, commissionAmount: 0 };
  }

  const commissionAmount = Math.round(Number(amount) * commissionRate);
  if (!Number.isInteger(commissionAmount) || commissionAmount <= 0) {
    throw new Error("Montant de commission invalide.");
  }

  const commission = await client.query(
    `INSERT INTO affiliate_commissions
       (affiliate_user_id, referred_user_id, payment_event_id,
        commission_type, offer, payment_amount, commission_rate,
        commission_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'available')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      affiliateUserId,
      request.user_id,
      paymentEventId,
      commissionType,
      offer,
      amount,
      commissionRate,
      commissionAmount
    ]
  );

  if (commission.rowCount !== 1) {
    throw new Error("La commission existe déjà ou n'a pas pu être enregistrée.");
  }

  return { paymentEventId, commissionType, commissionAmount };
}

async function initializeAffiliateSchema() {
  const fs = require("fs");
  const schemaPath = path.join(__dirname, "database", "affiliation-schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(schema);

    const legacyProfiles = await client.query(`
      SELECT user_id, referral_code
      FROM affiliate_profiles
      WHERE referral_code !~ '^BAT-[A-Z0-9]{4}$'
      ORDER BY user_id
      FOR UPDATE
    `);

    let migratedCount = 0;

    for (const profile of legacyProfiles.rows) {
      const oldCode = String(profile.referral_code).trim().toUpperCase();

      const activeCollision = await client.query(
        `SELECT user_id FROM affiliate_profiles WHERE UPPER(BTRIM(referral_code)) = $1`,
        [oldCode]
      );

      if (
        activeCollision.rowCount > 0 &&
        Number(activeCollision.rows[0].user_id) !== Number(profile.user_id)
      ) {
        throw new Error(`Ancien code en conflit avec un code actif : ${oldCode}`);
      }

      const aliasInsert = await client.query(
        `INSERT INTO affiliate_referral_code_aliases(referral_code, user_id)
         VALUES($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING user_id`,
        [oldCode, profile.user_id]
      );

      if (aliasInsert.rowCount === 0) {
        const existingAlias = await client.query(
          `SELECT user_id FROM affiliate_referral_code_aliases
           WHERE UPPER(BTRIM(referral_code)) = $1`,
          [oldCode]
        );

        if (
          existingAlias.rowCount !== 1 ||
          Number(existingAlias.rows[0].user_id) !== Number(profile.user_id)
        ) {
          throw new Error(`Ancien code associé à un autre compte : ${oldCode}`);
        }
      }

      let updated = false;

      for (let attempt = 0; attempt < 100 && !updated; attempt++) {
        const newCode = `BAT-${Array.from(
          { length: 4 },
          () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(36)]
        ).join("")}`;

        const codeInUse = await client.query(
          `SELECT 1 FROM affiliate_profiles WHERE UPPER(BTRIM(referral_code)) = $1
           UNION ALL
           SELECT 1 FROM affiliate_referral_code_aliases WHERE UPPER(BTRIM(referral_code)) = $1
           LIMIT 1`,
          [newCode]
        );

        if (codeInUse.rowCount) continue;

        const result = await client.query(
          `UPDATE affiliate_profiles
           SET referral_code = $1
           WHERE user_id = $2`,
          [newCode, profile.user_id]
        );

        updated = result.rowCount === 1;
      }

      if (!updated) {
        throw new Error(`Impossible de générer le code du compte ${profile.user_id}.`);
      }

      migratedCount++;
    }

    const users = await client.query(`
      SELECT u.id
      FROM users u
      LEFT JOIN affiliate_profiles a ON a.user_id = u.id
      WHERE a.user_id IS NULL
      ORDER BY u.id
      FOR UPDATE OF u
    `);

    let createdCount = 0;

    for (const user of users.rows) {
      let created = false;

      for (let attempt = 0; attempt < 8 && !created; attempt++) {
        const referralCode = `BAT-${Array.from(
          { length: 4 },
          () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[crypto.randomInt(36)]
        ).join("")}`;

        const codeInUse = await client.query(
          `SELECT 1 FROM affiliate_profiles WHERE UPPER(BTRIM(referral_code)) = $1
           UNION ALL
           SELECT 1 FROM affiliate_referral_code_aliases WHERE UPPER(BTRIM(referral_code)) = $1
           LIMIT 1`,
          [referralCode]
        );
        if (codeInUse.rowCount) continue;

        try {
          const result = await client.query(
            `INSERT INTO affiliate_profiles(user_id, referral_code)
             VALUES($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING user_id`,
            [user.id, referralCode]
          );

          if (result.rowCount === 1) {
            created = true;
            createdCount++;
          } else {
            const existing = await client.query(
              "SELECT user_id FROM affiliate_profiles WHERE user_id=$1",
              [user.id]
            );

            if (existing.rowCount === 1) {
              created = true;
            }
          }
        } catch (error) {
          if (error.code !== "23505") throw error;
        }
      }

      if (!created) {
        throw new Error(
          `Impossible de créer le code de parrainage du compte ${user.id}.`
        );
      }
    }

    await client.query("COMMIT");
    console.log(
      `BatBot : affiliation initialisée ; ${createdCount} profil(s) créé(s), ${migratedCount} code(s) migré(s).`
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

let server;

async function startServer() {
  try {
    await initializeSettings();
    await initializeSecurityQuestions();
    await initializeUserProfile();
    await initializeBookmakers();
    await initializeSportApiFixturesCache();
    await initializeAiPredictionHistory();
    await initializeAffiliateSchema();

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
