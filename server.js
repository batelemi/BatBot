const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DB = new Database(path.join(__dirname, "sdrive.db"));

app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// Render fonctionne derrière un proxy HTTPS.
app.set("trust proxy", 1);

DB.pragma("journal_mode = WAL");
DB.pragma("foreign_keys = ON");

DB.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT "",
  password_hash TEXT NOT NULL,
  premium_until TEXT,
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
`);

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
  orangeMoney: "",
  moovMoney: "",
  mtnMoney: "",
  adminPhone: process.env.ADMIN_PHONE || "2250152171974"
};

const getSetting = DB.prepare(
  "SELECT value FROM settings WHERE key=?"
);

const setSetting = DB.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) " +
  "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);

for (const [key, value] of Object.entries(defaults)) {
  setSetting.run(key, String(value));
}

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

  return {
    id: user.id,
    username: user.username,
    name: user.username,
    phone: user.phone,
    premium_until: user.premium_until,
    is_subscribed: active,
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
  secret:
    process.env.SESSION_SECRET ||
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
  const username = String(
    req.body.username || ""
  ).trim();

  const password = String(
    req.body.password || ""
  );

  if (!username || password.length < 6) {
    return res.status(400).json({
      error:
        "Nom d'utilisateur et mot de passe valides requis (6 caractères minimum)."
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

    req.session.userId = Number(
      result.lastInsertRowid
    );

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
  const username = String(
    req.body.username || ""
  ).trim();

  const password = String(
    req.body.password || ""
  );

  const user = DB.prepare(
    "SELECT * FROM users WHERE username=?"
  ).get(username);

  if (
    !user ||
    !bcrypt.compareSync(
      password,
      user.password_hash
    )
  ) {
    return res.status(401).json({
      error: "Identifiants incorrects."
    });
  }

  req.session.userId = user.id;

  res.json({
    message: "Connexion réussie.",
    user: userView(user)
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() =>
    res.json({
      message: "Déconnexion réussie."
    })
  );
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

app.post("/api/password-reset", (req, res) => {
  const username = String(
    req.body.username || ""
  ).trim();

  const user = DB.prepare(
    "SELECT id FROM users WHERE username=?"
  ).get(username);

  if (!user) {
    return res.status(404).json({
      error:
        "Utilisateur introuvable avec ces informations."
    });
  }

  DB.prepare(
    "INSERT INTO password_resets(user_id) VALUES(?)"
  ).run(user.id);

  res.json({
    message:
      "Demande envoyée à l'administration."
  });
});

// Compatibilité avec les anciennes versions de l'interface.
app.post("/api/forgot-password", (req, res) => {
  const username = String(
    req.body.username || ""
  ).trim();

  const user = DB.prepare(
    "SELECT id FROM users WHERE username=?"
  ).get(username);

  if (!user) {
    return res.status(404).json({
      error:
        "Utilisateur introuvable avec ces informations."
    });
  }

  const existing = DB.prepare(
    "SELECT id FROM password_resets " +
    "WHERE user_id=? AND status='pending' " +
    "ORDER BY id DESC LIMIT 1"
  ).get(user.id);

  if (!existing) {
    DB.prepare(
      "INSERT INTO password_resets(user_id) VALUES(?)"
    ).run(user.id);
  }

  res.json({
    message:
      "Demande envoyée à l'administration."
  });
});

app.get("/api/daily-matches", requireUser, (req, res) => {
  res.json({
    matches: DB.prepare(
      "SELECT * FROM daily_matches " +
      "WHERE match_date=? ORDER BY id DESC"
    ).all(today())
  });
});

app.post("/api/analysis-requests", requireUser, (req, res) => {
  const type =
    req.body.type === "loto"
      ? "loto"
      : "football";

  const content = String(
    req.body.content || ""
  ).trim();

  if (!content) {
    return res.status(400).json({
      error:
        type === "loto"
          ? "Envoyez les trois derniers résultats du tirage à analyser."
          : "Écrivez les matchs ou informations à analyser."
    });
  }

  if (type === "loto" && content.length < 10) {
    return res.status(400).json({
      error:
        "Pour une analyse Loto, indiquez les 3 derniers résultats du tirage."
    });
  }

  const id = DB.prepare(
    "INSERT INTO analysis_requests(user_id,type,content) " +
    "VALUES(?,?,?)"
  ).run(
    req.session.userId,
    type,
    content
  ).lastInsertRowid;

  const settings = getSettings();
  const phone = cleanPhone(
    settings.whatsapp
  );

  const label =
    type === "loto"
      ? "Loto"
      : "Football";

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
      ? `https://t.me/${String(
          settings.telegram
        ).replace(/^@/, "")}`
      : ""
  });
});

app.post("/api/admin/login", (req, res) => {
  const settings = getSettings();

  const phone = cleanPhone(
    req.body.phone
  );

  const configuredAdminPhone =
    cleanPhone(settings.adminPhone);

  const password = String(
    req.body.password || ""
  );

  if (
    !phone ||
    phone !== configuredAdminPhone ||
    !settings.adminPasswordHash ||
    !bcrypt.compareSync(
      password,
      settings.adminPasswordHash
    )
  ) {
    return res.status(401).json({
      error:
        "Accès administrateur refusé."
    });
  }

  req.session.admin = true;

  // Sauvegarde explicite de la session avant de répondre.
  req.session.save((err) => {
    if (err) {
      console.error(
        "Erreur sauvegarde session admin :",
        err
      );

      return res.status(500).json({
        error:
          "Impossible d'ouvrir la session administrateur."
      });
    }

    res.json({
      message:
        "Administration ouverte."
    });
  });
});

app.get("/api/admin/me", (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({
      error: "Non connecté."
    });
  }

  res.json({
    admin: true
  });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(
        "Erreur déconnexion admin :",
        err
      );

      return res.status(500).json({
        error:
          "Impossible de fermer la session administrateur."
      });
    }

    res.clearCookie("connect.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.NODE_ENV === "production"
    });

    res.json({
      message:
        "Administration déconnectée."
    });
  });
});
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({
    users: DB.prepare(
      "SELECT COUNT(*) AS n FROM users"
    ).get().n,

    analyses: DB.prepare(
      "SELECT COUNT(*) AS n FROM analysis_requests"
    ).get().n,

    pending: DB.prepare(
      "SELECT COUNT(*) AS n FROM analysis_requests " +
      "WHERE status='pending'"
    ).get().n,

    password_resets: DB.prepare(
      "SELECT COUNT(*) AS n FROM password_resets " +
      "WHERE status='pending'"
    ).get().n
  });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({
    users: DB.prepare(
      "SELECT * FROM users ORDER BY id DESC"
    ).all().map(userView)
  });
});

app.post("/api/admin/subscription", requireAdmin, (req, res) => {
  const id = Number(req.body.user_id);
  const active = !!req.body.active;

  const until = active
    ? new Date(
        Date.now() +
        7 * 24 * 60 * 60 * 1000
      ).toISOString()
    : null;

  const result = DB.prepare(
    "UPDATE users SET premium_until=? WHERE id=?"
  ).run(until, id);

  if (!result.changes) {
    return res.status(404).json({
      error: "Utilisateur introuvable."
    });
  }

  res.json({
    message: active
      ? "Premium activé pour 7 jours."
      : "Premium désactivé."
  });
});

app.post("/api/admin/reset-password", requireAdmin, (req, res) => {
  const password = String(
    req.body.password || ""
  );

  if (password.length < 6) {
    return res.status(400).json({
      error: "Minimum 6 caractères."
    });
  }

  const result = DB.prepare(
    "UPDATE users SET password_hash=? WHERE id=?"
  ).run(
    bcrypt.hashSync(password, 12),
    Number(req.body.user_id)
  );

  if (!result.changes) {
    return res.status(404).json({
      error: "Utilisateur introuvable."
    });
  }

  res.json({
    message:
      "Mot de passe modifié avec succès."
  });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const result = DB.prepare(
    "DELETE FROM users WHERE id=?"
  ).run(Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({
      error: "Utilisateur introuvable."
    });
  }

  res.json({
    message: "Membre supprimé."
  });
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

app.post(
  "/api/admin/reset-requests/:id/resolve",
  requireAdmin,
  (req, res) => {
    const id = Number(req.params.id);

    const request = DB.prepare(`
      SELECT
        pr.id,
        pr.user_id,
        pr.status,
        u.username
      FROM password_resets pr
      JOIN users u ON u.id=pr.user_id
      WHERE pr.id=?
    `).get(id);

    if (!request) {
      return res.status(404).json({
        error: "Demande introuvable."
      });
    }

    if (request.status !== "pending") {
      return res.status(409).json({
        error:
          "Cette demande a déjà été traitée."
      });
    }

    const alphabet =
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let temporaryPassword = "SD-";

    const bytes = crypto.randomBytes(8);

    for (const byte of bytes) {
      temporaryPassword +=
        alphabet[
          byte % alphabet.length
        ];
    }

    const transaction = DB.transaction(() => {
      DB.prepare(
        "UPDATE users SET password_hash=? WHERE id=?"
      ).run(
        bcrypt.hashSync(
          temporaryPassword,
          12
        ),
        request.user_id
      );

      DB.prepare(
        "UPDATE password_resets " +
        "SET status='resolved' WHERE id=?"
      ).run(id);
    });

    transaction();

    res.json({
      message:
        `Nouveau mot de passe généré pour ${request.username}.`,
      username: request.username,
      new_password:
        temporaryPassword
    });
  }
);

app.patch(
  "/api/admin/password-resets/:id",
  requireAdmin,
  (req, res) => {
    const status =
      req.body.status === "resolved"
        ? "resolved"
        : "pending";

    DB.prepare(
      "UPDATE password_resets SET status=? WHERE id=?"
    ).run(
      status,
      Number(req.params.id)
    );

    res.json({
      message:
        "Demande traitée."
    });
  }
);

app.get("/api/admin/requests", requireAdmin, (req, res) => {
  res.json({
    requests: DB.prepare(`
      SELECT
        ar.*,
        u.username,
        u.phone
      FROM analysis_requests ar
      LEFT JOIN users u
        ON u.id=ar.user_id
      ORDER BY ar.id DESC
    `).all()
  });
});

app.patch(
  "/api/admin/requests/:id",
  requireAdmin,
  (req, res) => {
    const allowed = [
      "pending",
      "processing",
      "completed",
      "cancelled"
    ];

    const status =
      allowed.includes(req.body.status)
        ? req.body.status
        : "pending";

    DB.prepare(
      "UPDATE analysis_requests " +
      "SET status=? WHERE id=?"
    ).run(
      status,
      Number(req.params.id)
    );

    res.json({
      message:
        "Demande mise à jour."
    });
  }
);

app.post(
  "/api/admin/daily-matches",
  requireAdmin,
  (req, res) => {
    const name = String(
      req.body.match_name || ""
    ).trim();

    const pick = String(
      req.body.recommended_pick || ""
    ).trim();

    const h = Number(
      req.body.home_probability
    );

    const d = Number(
      req.body.draw_probability
    );

    const a = Number(
      req.body.away_probability
    );

    const odds =
      req.body.odds === "" ||
      req.body.odds === undefined
        ? null
        : Number(req.body.odds);

    if (
      !name ||
      !pick ||
      ![h, d, a].every(
        Number.isFinite
      ) ||
      h < 0 ||
      h > 100 ||
      d < 0 ||
      d > 100 ||
      a < 0 ||
      a > 100 ||
      Math.abs(
        h + d + a - 100
      ) > 0.01
    ) {
      return res.status(400).json({
        error:
          "Probabilités invalides : elles doivent totaliser 100%."
      });
    }

    if (
      odds !== null &&
      (
        !Number.isFinite(odds) ||
        odds < 1
      )
    ) {
      return res.status(400).json({
        error: "Cote invalide."
      });
    }

    DB.prepare(`
      INSERT INTO daily_matches(
        match_name,
        home_probability,
        draw_probability,
        away_probability,
        recommended_pick,
        odds,
        match_date
      )
      VALUES(?,?,?,?,?,?,?)
    `).run(
      name,
      h,
      d,
      a,
      pick,
      odds,
      today()
    );

    res.status(201).json({
      message:
        "Match ajouté avec succès."
    });
  }
);

app.get(
  "/api/admin/daily-matches",
  requireAdmin,
  (req, res) => {
    res.json({
      matches: DB.prepare(
        "SELECT * FROM daily_matches " +
        "WHERE match_date=? ORDER BY id DESC"
      ).all(today())
    });
  }
);

app.delete(
  "/api/admin/daily-matches/:id",
  requireAdmin,
  (req, res) => {
    DB.prepare(
      "DELETE FROM daily_matches WHERE id=?"
    ).run(
      Number(req.params.id)
    );

    res.json({
      message:
        "Match supprimé."
    });
  }
);

app.get("/api/config", (req, res) => {
  const s = getSettings();

  res.json({
    whatsapp: s.whatsapp,
    telegram: s.telegram,
    whatsappGroup:
      s.whatsappGroup,
    telegramGroup:
      s.telegramGroup,
    tiktok: s.tiktok,
    facebook: s.facebook,
    instagram: s.instagram,
    wave500: s.wave500,
    wave1000: s.wave1000,
    wavePromo: s.wavePromo,
    promoFee: s.promoFee,
    orangeMoney:
      s.orangeMoney,
    moovMoney:
      s.moovMoney,
    mtnMoney:
      s.mtnMoney,

    bookmakers: [
      {
        name: "1WIN",
        bonus: "500%",
        url:
          "https://1wyvrz.life/?p=gc9k"
      },
      {
        name: "PARIPESA",
        bonus: "500%",
        url:
          "https://combodef.com/L?tag=d_4081071m_60651c_&site=4081071&ad=60651"
      },
      {
        name: "AFROPARI",
        bonus: "300%",
        url:
          "https://apaff.top/L?tag=d_3763651m_70055c_&site=3763651&ad=70055"
      },
      {
        name: "MELBET",
        bonus: "200%",
        url:
          "https://refpa3665.com/L?tag=d_4685320m_66335c_&site=4685320&ad=66335"
      },
      {
        name: "LOTO",
        bonus: "",
        url:
          "https://jdnlotto.com/register?promo=123"
      }
    ]
  });
});

app.get(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    const s = getSettings();

    delete s.adminPasswordHash;

    res.json({
      settings: s
    });
  }
);

app.patch(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    const allowed = [
      "whatsapp",
      "telegram",
      "whatsappGroup",
      "telegramGroup",
      "tiktok",
      "facebook",
      "instagram",
      "wave500",
      "wave1000",
      "wavePromo",
      "promoFee",
      "orangeMoney",
      "moovMoney",
      "mtnMoney",
      "adminPhone"
    ];

    for (const key of allowed) {
      if (
        req.body[key] !== undefined
      ) {
        setSetting.run(
          key,
          String(req.body[key])
        );
      }
    }

    res.json({
      message:
        "Configuration enregistrée.",
      settings:
        getSettings()
    });
  }
);

// Le dépôt utilise le dossier public.
app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.listen(PORT, () => {
  console.log(
    `S-Drive démarré sur le port ${PORT}`
  );
});
