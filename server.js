/**
 * Agent WhatsApp multi-garages (vente de véhicules ou réparation).
 * Flux : WhatsApp -> POST /webhook -> résolution du garage -> mots-clés -> Supabase -> Groq (Llama 3) -> réponse.
 */
// Doit rester en tête : certains hébergeurs (Render) n'ont pas de sortie IPv6,
// et Node >= 18 tente l'AAAA en premier -> `TypeError: fetch failed`.
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const express = require('express');

const {
  findCars,
  listAvailableCars,
  findServices,
  listServices,
  logAppointmentRequest,
  checkConnection,
  SUPABASE_URL,
} = require('./src/services/supabase');
const { generateReply } = require('./src/services/ai');
const { extractKeywords } = require('./src/utils/extract');
const { parseIncoming, toTwiml, formatForWhatsApp } = require('./src/services/whatsapp');
const twilioService = require('./src/services/twilio');
const metaService = require('./src/services/meta');
const adminRouter = require('./src/routes/admin');
const superadminRouter = require('./src/routes/superadmin');
const { resolveWebhookGarage } = require('./src/services/tenant');
const stripeBilling = require('./src/services/stripeBilling');

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook Stripe : doit lire le corps BRUT (non parsé) pour vérifier la
// signature -> enregistré avant express.json() global, uniquement sur ce chemin.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripeBilling.verifyWebhookSignature(req.body, req.get('stripe-signature'));
  } catch (err) {
    console.warn('[SECU] Signature Stripe invalide:', err.message);
    return res.status(400).send(`Webhook signature invalide: ${err.message}`);
  }

  try {
    await stripeBilling.handleWebhookEvent(event);
    return res.json({ received: true });
  } catch (err) {
    console.error('[ERR] traitement webhook Stripe:', err);
    // 500 -> Stripe réessaiera automatiquement.
    return res.status(500).json({ error: err.message });
  }
});

// Twilio envoie du form-urlencoded, Meta et Postman du JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Fichiers statiques (admin.html, futurs assets) : /admin.html, /favicon.ico, ...
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Interface web d'administration (connexion par compte Supabase Auth, l'API vérifie le token).
app.get(['/admin', '/admin/', '/admin/index.html'], (_req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'), (err) => (err ? next(err) : undefined));
});

// API d'administration (stock véhicules ou services/RDV selon le métier du garage).
app.use('/admin', adminRouter);

// Interface + API super-admin (pilotage de tous les garages, réservé à la table `superadmins`).
app.get(['/superadmin', '/superadmin/', '/superadmin/index.html'], (_req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'superadmin.html'), (err) => (err ? next(err) : undefined));
});
app.use('/superadmin', superadminRouter);

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
 * Configuration publique pour le navigateur (page /admin) : URL + clé anon
 * Supabase, nécessaires à Supabase Auth JS côté client. La clé anon est
 * prévue pour être publique (elle ne donne aucun accès sans RLS/policy).
 */
app.get('/config', (_req, res) => {
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (!SUPABASE_URL || !supabaseAnonKey) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY non configurées sur le serveur' });
  }
  // Réutilise l'URL déjà normalisée par services/supabase.js (espaces, slash final,
  // guillemets collés depuis le dashboard Render) pour éviter un chemin malformé
  // côté Supabase Auth JS dans le navigateur ("Invalid path specified in request URL").
  return res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey });
});

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
 * Cœur de l'agent : message client -> réponse vendeur/réceptionniste,
 * selon le métier du garage résolu pour ce numéro WhatsApp.
 * @param {{id: string, name: string, vertical: 'vente'|'reparation'}} garage
 * @param {string} message
 * @param {string} from numéro du client (pour journaliser une demande de RDV)
 * @returns {Promise<{reply: string, keywords: string[], context: Array}>}
 */
async function buildAnswer(garage, message, from) {
  const keywords = extractKeywords(message);

  if (garage.vertical === 'reparation') {
    let services = keywords.length ? await findServices(garage.id, keywords) : [];
    if (services.length === 0) services = await listServices(garage.id, 5);

    const aiText = await generateReply(garage, message, services);

    // Best-effort : un échec de journalisation ne doit jamais casser la réponse au client.
    logAppointmentRequest(garage.id, from, message, services[0]?.id || null).catch((err) =>
      console.error('[WARN] journalisation RDV échouée:', err.message)
    );

    return { reply: formatForWhatsApp(aiText), keywords, context: services };
  }

  let cars = keywords.length ? await findCars(garage.id, keywords) : [];
  if (cars.length === 0) cars = await listAvailableCars(garage.id, 3);

  const aiText = await generateReply(garage, message, cars);
  return { reply: formatForWhatsApp(aiText), keywords, context: cars };
}

/**
 * Webhook principal : reçoit le message du prospect et renvoie la réponse du vendeur IA.
 * - Twilio : réponse directe en TwiML (REPLY_MODE=twiml, défaut) ou via l'API (REPLY_MODE=api)
 * - Meta   : accusé de réception immédiat puis envoi via l'API Graph
 */
app.post('/webhook', async (req, res) => {
  const { channel, from, to, body } = parseIncoming(req);
  console.log(`[IN ] ${channel} ${from} -> ${to}: ${body}`);

  // Résout le garage destinataire à partir du numéro appelé (repli sur DEFAULT_GARAGE_ID pour le garage pilote).
  let garage;
  try {
    garage = await resolveWebhookGarage(to);
  } catch (err) {
    console.error('[ERR] résolution du garage:', err.message);
    const fallback = 'Service temporairement indisponible. Merci de réessayer plus tard.';
    if (channel === 'twilio') return res.type('text/xml').status(200).send(toTwiml(fallback));
    if (channel === 'meta') return res.sendStatus(200);
    return res.status(500).json({ error: err.message, reply: fallback });
  }

  // Signature Twilio : vérifiée ici (et non en middleware) car elle dépend du
  // sous-compte du garage résolu ci-dessus, connu seulement après lecture du corps.
  if (channel === 'twilio' && !twilioService.isSignatureValid(req, garage.twilioAuthToken)) {
    console.warn('[SECU] Signature Twilio invalide pour', req.originalUrl);
    return res.status(403).send('Invalid Twilio signature');
  }

  // Garage non actif (abonnement impayé/suspendu, ou en attente d'activation) :
  // repli fixe, jamais d'appel IA ni d'erreur brute envoyée au client.
  if (garage.status !== 'active') {
    const fallback = 'Ce service est temporairement indisponible. Merci de contacter directement le garage.';
    console.warn(`[GATE] garage ${garage.id} statut=${garage.status}, réponse de repli envoyée`);
    if (channel === 'twilio') return res.type('text/xml').send(toTwiml(fallback));
    if (channel === 'meta') return res.sendStatus(200);
    return res.json({ reply: fallback, keywords: [], context: [] });
  }

  try {
    if (!body.trim()) {
      const empty =
        garage.vertical === 'reparation'
          ? 'Bonjour ! Quel service recherchez-vous ? (vidange, révision, pneus, contrôle technique...)'
          : 'Bonjour ! Quel véhicule recherchez-vous ? (marque et modèle)';
      if (channel === 'twilio') return res.type('text/xml').send(toTwiml(empty));
      if (channel === 'meta') return res.sendStatus(200);
      return res.json({ reply: empty, keywords: [], context: [] });
    }

    // Meta : répondre 200 tout de suite (sinon Meta réessaie), puis envoyer via l'API.
    if (channel === 'meta') {
      res.sendStatus(200);
      const { reply } = await buildAnswer(garage, body, from);
      await metaService.sendWhatsApp(from, reply);
      console.log(`[OUT] meta ${from}: ${reply}`);
      return undefined;
    }

    const { reply, keywords, context } = await buildAnswer(garage, body, from);
    console.log(`[OUT] ${channel} ${from}: ${reply}`);

    if (channel === 'twilio') {
      // Mode "api" : envoi explicite via l'API Twilio, webhook répondu à vide.
      if ((process.env.REPLY_MODE || 'twiml').toLowerCase() === 'api') {
        await twilioService.sendWhatsApp(from, reply, {
          accountSid: garage.twilioAccountSid,
          authToken: garage.twilioAuthToken,
          from: garage.whatsappFrom,
        });
        return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }
      return res.type('text/xml').send(toTwiml(reply));
    }

    return res.json({
      reply,
      keywords,
      ...(garage.vertical === 'reparation'
        ? { services: context.map((s) => ({ id: s.id, name: s.name })) }
        : { cars: context.map((c) => ({ id: c.id, brand: c.brand, model: c.model })) }),
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
    routes: [
      'GET /',
      'GET /config',
      'GET /admin',
      'GET /admin/me',
      'GET|POST /webhook',
      'GET|POST /admin/cars',
      'PATCH|DELETE /admin/cars/:id',
      'GET|POST /admin/services',
      'PATCH|DELETE /admin/services/:id',
      'GET|POST /admin/appointments',
      'PATCH|DELETE /admin/appointments/:id',
      'GET|POST /admin/quotes',
      'PATCH|DELETE /admin/quotes/:id',
      'GET /superadmin',
      'GET|POST /superadmin/garages',
      'POST /superadmin/garages/:id/checkout-link',
      'POST /superadmin/garages/:id/provision-whatsapp',
      'PATCH /superadmin/garages/:id/status',
      'POST /stripe/webhook',
    ],
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

  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  console.log(
    supabaseAnonKey
      ? 'SUPABASE_ANON_KEY chargée (connexion admin via Supabase Auth)'
      : 'ATTENTION: SUPABASE_ANON_KEY absente, la page /admin ne pourra pas se connecter'
  );

  const defaultGarageId = String(process.env.DEFAULT_GARAGE_ID || '').trim();
  console.log(
    defaultGarageId
      ? `DEFAULT_GARAGE_ID chargé (${defaultGarageId})`
      : 'ATTENTION: DEFAULT_GARAGE_ID absent, /webhook répondra une erreur de service'
  );

  console.log(
    stripeBilling.isConfigured
      ? 'Stripe configuré (facturation active)'
      : "Stripe non configuré (STRIPE_SECRET_KEY/STRIPE_PRICE_ID absents) — génération de lien de paiement indisponible"
  );

  console.log(`Résolution DNS: ${dns.getDefaultResultOrder()}`);

  // Diagnostic Supabase au démarrage (visible dans les logs Render).
  checkConnection().then(({ ok, url, error }) =>
    console.log(ok ? `Supabase connecté (${url})` : `ATTENTION Supabase: ${error}`)
  );
});

module.exports = app;
