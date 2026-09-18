app.post("/api/ai/analyze", requireUser, async (req, res) => {
  const homeTeam = String(req.body.home_team || req.body.team1 || "").trim();
  const awayTeam = String(req.body.away_team || req.body.team2 || "").trim();
  const context = String(req.body.context || "").trim().slice(0, 4000);

  if (!homeTeam || !awayTeam || homeTeam.length > 100 || awayTeam.length > 100) {
    return res.status(400).json({
      error: "Indiquez deux équipes valides."
    });
  }

  const user = DB.prepare("SELECT * FROM users WHERE id=?")
    .get(req.session.userId);

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
    "2. Probabilités estimées (victoire domicile, nul, victoire extérieur)",
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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

      data = await response.json();

      if (response.ok || response.status !== 503 || attempt === 3) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 2000)
      );
    }

    if (!response.ok) {
      console.error("GEMINI_ERROR", response.status, data);

      return res.status(502).json({
        error: "S-Drive IA reçoit trop de demandes pour l’instant. Réessayez dans quelques secondes."
      });
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("\n")
      .trim();

    if (!text) {
      return res.status(502).json({
        error: "Gemini n'a pas retourné de résultat exploitable."
      });
    }

    const content = `Analyse IA : ${homeTeam} vs ${awayTeam}\n\n${text}`;

    const requestId = DB.prepare(
      "INSERT INTO analysis_requests(user_id,type,content,status) VALUES(?,?,?,?)"
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
      error: "Impossible de joindre Gemini pour le moment."
    });
  }
});
