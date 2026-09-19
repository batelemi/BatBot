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
  ai_started_at TEXT,
  ai_until TEXT,
  ai_revoked_at TEXT,
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
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
`);

// Migrations pour les bases déjà existantes
try {
  DB.prepare(
    "ALTER TABLE users ADD COLUMN premium_started_at TEXT"
  ).run();
} catch (_) {}

try {
  DB.prepare(
    "ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0"
  ).run();
} catch (_) {}

try {
  DB.prepare(
    "ALTER TABLE users ADD COLUMN ai_started_at TEXT"
  ).run();
} catch (_) {}

try {
  DB.prepare(
    "ALTER TABLE users ADD COLUMN ai_until TEXT"
  ).run();
} catch (_) {}

try {
  DB.prepare(
    "ALTER TABLE users ADD COLUMN ai_revoked_at TEXT"
  ).run();
} catch (_) {}

const defaults = {
  whatsapp: "2250152171974",
  telegram: "@Sdrive12",
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
  sdriveInviteMessage: "Invite tes amis à rejoindre S-Drive et profite de tes avantages.",
  adminPhone: process.env.ADMIN_PHONE || "2250152171974"
};

const getSetting = DB.prepare(
  "SELECT value FROM settings WHERE key=?"
);

const setSetting = DB.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);

for (const [key, value] of Object.entries(defaults)) {
  if (!getSetting.get(key)) {
    setSetting.run(key, String(value));
  }
}

// Correction automatique des anciennes coordonnées
try {
  const oldNumber = "2250152171774";
  const newNumber = "2250152171974";

  const currentWhatsapp = getSetting.get("whatsapp");
  const currentAdminPhone = getSetting.get("adminPhone");

  if (
    currentWhatsapp &&
    String(currentWhatsapp.value) === oldNumber
  ) {
    setSetting.run("whatsapp", newNumber);
  }

  if (
    currentAdminPhone &&
    String(currentAdminPhone.value) === oldNumber
  ) {
    setSetting.run("adminPhone", newNumber);
  }
} catch (_) {}

if (!getSetting.get("adminPasswordHash")) {
  setSetting.run(
    "adminPasswordHash",
    bcrypt.hashSync(
      process.env.ADMIN_PASSWORD || "ChangeMe123!",
      12
    )
  );
}

function getSettings() {
  return Object.fromEntries(
    DB.prepare("SELECT key,value FROM settings")
      .all()
      .map(x => [x.key, x.value])
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

  const active = !!(
    user.premium_until &&
    new Date(user.premium_until) > new Date()
  );

  const aiActive = !!(
    user.ai_until &&
    new Date(user.ai_until) > new Date()
  ) && !user.ai_revoked_at;

  return {
    id: user.id,
    username: user.username,
    name: user.username,
    phone: user.phone,
    premium_until: user.premium_until,
    premium_started_at: user.premium_started_at || null,
    ai_started_at: user.ai_started_at || null,
    ai_until: user.ai_until || null,
    ai_active: aiActive,
    disabled: Boolean(user.disabled),
    is_subscribed: active && !Boolean(user.disabled),
    subscribed: active,
    subscription_active: active,
    created_at: user.created_at
  };
}

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Connexion requise."
    });
  }

  const user = DB.prepare(
    "SELECT id, disabled FROM users WHERE id=?"
  ).get(req.session.userId);

  if (!user || user.disabled) {
    req.session.destroy(() => {});

    return res.status(403).json({
      error: "Ce compte est désactivé ou introuvable."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({
      error: "Accès administrateur refusé."
    });
  }

  next();
}

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: __dirname
  }),
  secret: process.env.SESSION_SECRET ||
    "CHANGE_THIS_SECRET_IN_PRODUCTION",
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
  res.json({
    ok: true,
    service: "S-Drive",
    time: new Date().toISOString()
  });
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
    ).run(
      username,
      "",
      bcrypt.hashSync(password, 12)
    );

    req.session.userId = Number(result.lastInsertRowid);

    const user = DB.prepare(
      "SELECT * FROM users WHERE id=?"
    ).get(result.lastInsertRowid);

    res.status(201).json({
      message: "Compte créé avec succès.",
      user: userView(user)
    });
  } catch (error) {
    res.status(409).json({
      error: "Ce nom d'utilisateur existe déjà."
    });
  }
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const user = DB.prepare(
    "SELECT * FROM users WHERE username=?"
  ).get(username);

  if (
    !user ||
    user.disabled ||
    !bcrypt.compareSync(password, user.password_hash)
  ) {
    return res.status(401).json({
      error: "Identifiants incorrects ou compte désactivé."
    });
  }

  req.session.userId = user.id;

  res.json({
    message: "Connexion réussie.",
    user: userView(user)
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({
      message: "Déconnexion réussie."
    });
  });
});

app.get("/api/me", requireUser, (req, res) => {
  const user = DB.prepare(
    "SELECT * FROM users WHERE id=?"
  ).get(req.session.userId);

  if (!user) {
    return res.status(401).json({
      error: "Session invalide."
    });
  }

  res.json({
    user: userView(user)
  });
});

app.get("/api/session", (req, res) => {
  if (!req.session.userId) {
    return res.json({
      user: null
    });
  }

  const user = DB.prepare(
    "SELECT * FROM users WHERE id=?"
  ).get(req.session.userId);

  if (!user || user.disabled) {
    return res.json({
      user: null
    });
  }

  res.json({
    user: userView(user)
  });
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

  DB.prepare(
    "INSERT INTO password_resets(user_id) VALUES(?)"
  ).run(user.id);

  res.json({
    message: "Demande envoyée à l'administration."
  });
});

app.post("/api/forgot-password", (req, res) => {
  const username = String(req.body.username || "").trim();

  const user = DB.prepare(
    "SELECT id FROM users WHERE username=?"
  ).get(username);

  if (!user) {
    return res.status(404).json({
      error: "Utilisateur introuvable avec ces informations."
    });
  }

  const existing = DB.prepare(
    "SELECT id FROM password_resets WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (!existing) {
    DB.prepare(
      "INSERT INTO password_resets(user_id) VALUES(?)"
    ).run(user.id);
  }

  res.json({
    message: "Demande envoyée à l'administration."
  });
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
  ).run(
    req.session.userId,
    type,
    content
  ).lastInsertRowid;

  const settings = getSettings();
  const phone = cleanPhone(settings.whatsapp);
  const label = type === "loto" ? "Loto" : "Football";

  const text =
    `Bonjour S-Drive 👋\n\n` +
    `Je souhaite demander une analyse ${label}.\n\n` +
    `${content}\n\n` +
    `Référence de ma demande : S-Drive #${id}`;

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

function isAiActive(user) {
  return Boolean(
    user &&
    user.ai_until &&
    new Date(user.ai_until) > new Date() &&
    !user.ai_revoked_at &&
    !user.disabled
  );
});

app.post("/api/ai/analyze", requireUser, async (req, res) => {
  const homeTeam = String(
    req.body.home_team || req.body.team1 || ""
  ).trim();

  const awayTeam = String(
    req.body.away_team || req.body.team2 || ""
  ).trim();

  const context = String(
    req.body.context || ""
  ).trim().slice(0, 4000);

  if (
    !homeTeam ||
    !awayTeam ||
    homeTeam.length > 100 ||
    awayTeam.length > 100
  ) {
    return res.status(400).json({
      error: "Indiquez deux équipes valides."
    });
  }

  const user = DB.prepare(
    "SELECT * FROM users WHERE id=?"
  ).get(req.session.userId);

  if (!isAiActive(user)) {
    return res.status(403).json({
      error: "Votre accès IA est inactif ou expiré."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "Le moteur IA n'est pas configuré par l'administrateur."
    });
  }

  const prompt = [
    "Tu es S-Drive IA, un assistant d'analyse football.",
    `Match : ${homeTeam} contre ${awayTeam}.`,
    `Informations fournies : ${context || "Aucune"}.`,
    "Réponds en français, de manière courte et claire.",
    "Donne uniquement :",
    "1. Équipe favorite",
    "2. Probabilités estimées : domicile, nul, extérieur",
    "3. Deux ou trois options de pari à considérer",
    "4. Une cote indicative pour chaque option",
    "5. Niveau de risque : faible, moyen ou élevé",
    "Ne donne pas de longues explications.",
    "N'invente aucune statistique."
  ].join("\n");

  try {
    let response;
    let data;

    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              maxOutputTokens: 500,
              temperature: 0.4
            }
          })
        }
      );

      data = await response.json();

      if (
        response.ok ||
        response.status !== 503 ||
        attempt === 3
      ) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 3000)
      );
    }

    if (!response.ok) {
      console.error("GEMINI_ERROR", response.status, data);

      return res.status(502).json({
        error: "S-Drive IA est temporairement indisponible. Réessayez dans quelques secondes."
      });
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("\n")
      .trim();

    if (!text) {
      return res.status(502).json({
        error: "L'IA n'a pas retourné de résultat exploitable."
      });
    }

    const content =
      `Analyse IA : ${homeTeam} vs ${awayTeam}\n\n${text}`;

    const requestId = DB.prepare(
      `INSERT INTO analysis_requests
      (user_id, type, content, status)
      VALUES (?, ?, ?, ?)`
    ).run(
      req.session.userId,
      "football_ai",
      content,
      "completed"
    ).lastInsertRowid;

    res.json({
      request_id: Number(requestId),
      analysis: text
    });

  } catch (error) {
    console.error("GEMINI_REQUEST_ERROR", error);

    res.status(502).json({
      error: "Impossible de joindre le service IA pour le moment."
    });
  }
});
function isAiActive(user) {
  return Boolean(
    user &&
    user.ai_until &&
    new Date(user.ai_until).getTime() > Date.now() &&
    !user.ai_revoked_at
  );
}

app.post("/api/ai/analyze", requireAuth, async (req, res) => {
  try {
    const user = getUserById(req.session.userId);

    if (!isAiActive(user)) {
      return res.status(403).json({
        error: "Votre accès à S-Drive IA est expiré ou désactivé."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Service IA temporairement indisponible."
      });
    }

    const { homeTeam, awayTeam, context } = req.body;

    const prompt = [
      "Tu es S-Drive IA, un assistant d'analyse football.",
      `Match : ${homeTeam} contre ${awayTeam}.`,
      `Informations fournies : ${context || "Aucune"}.`,
      "Réponds en français, de manière courte et claire.",
      "Donne uniquement :",
      "1. Équipe favorite",
      "2. Probabilités estimées : domicile, nul, extérieur",
      "3. Deux ou trois options à considérer",
      "4. Une cote indicative pour chaque option",
      "5. Niveau de risque : faible, moyen ou élevé",
      "Ne donne pas de longues explications.",
      "N'invente aucune statistique."
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("GEMINI_ERROR", response.status, data);

      return res.status(503).json({
        error: "S-Drive IA reçoit trop de demandes. Réessayez dans quelques secondes."
      });
    }

    const result =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Aucune analyse disponible.";

    res.json({
      success: true,
      analysis: result
    });

  } catch (error) {
    console.error("AI_ANALYSIS_ERROR", error);

    res.status(500).json({
      error: "Une erreur est survenue pendant l'analyse."
    });
  }
});
app.post("/api/admin/ai-subscription", requireAdmin, (req, res) => {
  try {
    const { userId, action, days } = req.body;

    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({
        error: "Utilisateur introuvable."
      });
    }

    if (action === "activate") {
      const duration = Number(days) || 7;

      const aiUntil = new Date(
        Date.now() + duration * 24 * 60 * 60 * 1000
      ).toISOString();

      db.prepare(`
        UPDATE users
        SET ai_started_at = ?,
            ai_until = ?,
            ai_revoked_at = NULL
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        aiUntil,
        userId
      );

      return res.json({
        success: true,
        message: `Accès IA activé pour ${duration} jours.`
      });
    }

    if (action === "deactivate") {
      db.prepare(`
        UPDATE users
        SET ai_revoked_at = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        userId
      );

      return res.json({
        success: true,
        message: "Accès IA désactivé."
      });
    }

    return res.status(400).json({
      error: "Action invalide."
    });

  } catch (error) {
    console.error("ADMIN_AI_ERROR", error);

    res.status(500).json({
      error: "Erreur lors de la gestion de l'accès IA."
    });
  }
});
<section id="ai-section" class="card">
  <h2>🤖 S-Drive IA</h2>

  <input
    id="homeTeam"
    type="text"
    placeholder="Équipe à domicile"
  />

  <input
    id="awayTeam"
    type="text"
    placeholder="Équipe extérieure"
  />

  <textarea
    id="matchContext"
    placeholder="Informations du match (facultatif)"
  ></textarea>

  <button onclick="analyzeMatch()">
    Analyser le match
  </button>

  <p id="aiStatus"></p>

  <pre id="aiResult"></pre>
</section>

<script>
async function analyzeMatch() {
  const homeTeam = document.getElementById("homeTeam").value.trim();
  const awayTeam = document.getElementById("awayTeam").value.trim();
  const context = document.getElementById("matchContext").value.trim();

  const status = document.getElementById("aiStatus");
  const result = document.getElementById("aiResult");

  if (!homeTeam || !awayTeam) {
    status.textContent = "Veuillez saisir les deux équipes.";
    return;
  }

  status.textContent =
    "🤖 S-Drive IA : analyse en cours... Patientez quelques secondes.";

  result.textContent = "";

  try {
    const response = await fetch("/api/ai/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        homeTeam,
        awayTeam,
        context
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Analyse indisponible.");
    }

    result.textContent = data.analysis;
    status.textContent = "Analyse terminée.";

  } catch (error) {
    status.textContent = error.message;
  }
}
</script>
