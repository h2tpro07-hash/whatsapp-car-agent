/**
 * Agent WhatsApp pour marchand de voitures d'occasion.
 * Flux : WhatsApp -> POST /webhook -> mots-clés -> Supabase -> Groq (Llama 3) -> réponse.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const express = require('express');

const { findCars, listAvailableCars, checkConnection } = require('./src/services/supabase');
const { generateReply } = require('./src/services/ai');
const { extractKeywords } = require('./src/utils/extract');
const { parseIncoming, toTwiml, formatForWhatsApp } = require('./src/services/whatsapp');
const twilioService = require('./src/services/twilio');
const metaService = require('./src/services/meta');
const adminRouter = require('./src/routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio envoie du form-urlencoded, Meta et Postman du JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Fichiers statiques (admin.html, futurs assets) : /admin.html, /favicon.ico, ...
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Interface web d'administration (la page demande la clé, l'API la vérifie).
app.get(['/admin', '/admin/', '/admin/index.html'], (_req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'), (err) => (err ? next(err) : undefined));
});

// API d'administration du stock (protégée par x-admin-key).
app.use('/admin', adminRouter);

/** Healthcheck : indique aussi quels canaux sortants sont configurés. */
app.get('/', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'whatsapp-car-agent',
    twilio: twilioService.isConfigured,
    meta: metaService.isConfigured,
  })
);

/**
 * Vérification du webhook Meta (WhatsApp Cloud API).
 * Twilio n'en a pas besoin.
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Cœur de l'agent : message client -> réponse vendeur.
 * @param {string} message
 * @returns {Promise<{reply: string, keywords: string[], cars: Array}>}
 */
async function buildAnswer(message) {
  // 1. Extraire les mots-clés (marque / modèle)
  const keywords = extractKeywords(message);

  // 2. Interroger Supabase (fallback : catalogue disponible)
  let cars = keywords.length ? await findCars(keywords) : [];
  if (cars.length === 0) cars = await listAvailableCars(3);

  // 3. Générer la réponse avec Groq à partir des seules données Supabase
  const aiText = await generateReply(message, cars);

  // 4. Formater pour WhatsApp
  return { reply: formatForWhatsApp(aiText), keywords, cars };
}

/**
 * Webhook principal : reçoit le message du prospect et renvoie la réponse du vendeur IA.
 * - Twilio : réponse directe en TwiML (REPLY_MODE=twiml, défaut) ou via l'API (REPLY_MODE=api)
 * - Meta   : accusé de réception immédiat puis envoi via l'API Graph
 */
app.post('/webhook', twilioService.verifyTwilioSignature, async (req, res) => {
  const { channel, from, body } = parseIncoming(req);
  console.log(`[IN ] ${channel} ${from}: ${body}`);

  try {
    if (!body.trim()) {
      const empty = 'Bonjour ! Quel véhicule recherchez-vous ? (marque et modèle)';
      if (channel === 'twilio') return res.type('text/xml').send(toTwiml(empty));
      if (channel === 'meta') return res.sendStatus(200);
      return res.json({ reply: empty, cars: [] });
    }

    // Meta : répondre 200 tout de suite (sinon Meta réessaie), puis envoyer via l'API.
    if (channel === 'meta') {
      res.sendStatus(200);
      const { reply } = await buildAnswer(body);
      await metaService.sendWhatsApp(from, reply);
      console.log(`[OUT] meta ${from}: ${reply}`);
      return undefined;
    }

    const { reply, keywords, cars } = await buildAnswer(body);
    console.log(`[OUT] ${channel} ${from}: ${reply}`);

    if (channel === 'twilio') {
      // Mode "api" : envoi explicite via l'API Twilio, webhook répondu à vide.
      if ((process.env.REPLY_MODE || 'twiml').toLowerCase() === 'api') {
        await twilioService.sendWhatsApp(from, reply);
        return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }
      return res.type('text/xml').send(toTwiml(reply));
    }

    return res.json({
      reply,
      keywords,
      cars: cars.map((c) => ({ id: c.id, brand: c.brand, model: c.model })),
    });
  } catch (err) {
    console.error('[ERR]', err);
    const fallback = 'Désolé, un problème technique est survenu. Un conseiller vous répondra très vite.';

    if (res.headersSent) return undefined;
    if (channel === 'twilio') return res.type('text/xml').status(200).send(toTwiml(fallback));
    if (channel === 'meta') return res.sendStatus(200);
    return res.status(500).json({ error: err.message, reply: fallback });
  }
});

/** 404 explicite : évite un « Not Found » opaque en production. */
app.use((req, res) => {
  res.status(404).json({
    error: `Route introuvable: ${req.method} ${req.originalUrl}`,
    routes: ['GET /', 'GET /admin', 'GET|POST /webhook', 'GET|POST /admin/cars', 'PATCH|DELETE /admin/cars/:id'],
  });
});

/** Gestionnaire d'erreurs (routes /admin). */
app.use((err, _req, res, _next) => {
  console.error('[ERR]', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  // Aide au diagnostic en production (Render/Docker) : la page admin est-elle bien déployée ?
  const adminPage = path.join(PUBLIC_DIR, 'admin.html');
  console.log(
    fs.existsSync(adminPage)
      ? `Interface admin disponible sur /admin (${adminPage})`
      : `ATTENTION: ${adminPage} introuvable, /admin renverra une erreur`
  );

  // Diagnostic Supabase au démarrage (visible dans les logs Render).
  checkConnection().then(({ ok, url, error }) =>
    console.log(ok ? `Supabase connecté (${url})` : `ATTENTION Supabase: ${error}`)
  );
});

module.exports = app;
