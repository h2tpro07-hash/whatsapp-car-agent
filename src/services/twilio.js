/**
 * Envoi sortant Twilio (WhatsApp) + validation de signature des webhooks.
 * Le compte "maître" (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) sert au garage
 * pilote (mono-numéro historique) et au provisioning des sous-comptes
 * (voir twilioProvisioning.js). Les garages provisionnés en Phase 2 utilisent
 * leurs propres identifiants de sous-compte, résolus par tenant.js et passés
 * explicitement à ce module.
 */
const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, PUBLIC_URL, VALIDATE_TWILIO_SIGNATURE } =
  process.env;

const isConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);
const masterClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

/** Préfixe `whatsapp:` requis par Twilio. */
function toWhatsAppAddress(number) {
  const n = String(number).trim();
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n}`;
}

/**
 * Envoie un message WhatsApp (mode REPLY_MODE=api, ou message proactif).
 * Sans identifiants explicites, utilise le compte maître + TWILIO_WHATSAPP_FROM
 * (garage pilote). Pour un garage provisionné, passer ses identifiants de
 * sous-compte et son propre numéro.
 * @param {string} to numéro destinataire (+33...)
 * @param {string} body texte
 * @param {{accountSid?: string, authToken?: string, from?: string}} [creds]
 */
async function sendWhatsApp(to, body, creds = {}) {
  const client = creds.accountSid && creds.authToken ? twilio(creds.accountSid, creds.authToken) : masterClient;
  const fromNumber = creds.from || TWILIO_WHATSAPP_FROM;

  if (!client || !fromNumber) {
    throw new Error('Twilio non configuré (identifiants ou numéro expéditeur manquants)');
  }

  const msg = await client.messages.create({
    from: toWhatsAppAddress(fromNumber),
    to: toWhatsAppAddress(to),
    body,
  });
  return { sid: msg.sid, status: msg.status };
}

/**
 * Vérifie la signature Twilio d'une requête webhook avec le token du garage
 * résolu (sous-compte) ou le token maître (garage pilote). Retourne `true`
 * si la validation est désactivée (VALIDATE_TWILIO_SIGNATURE != 'true'),
 * si aucun token n'est disponible, ou si la requête n'est pas signée
 * (tests locaux JSON/Postman) — dans ces cas, ce n'est pas à cette fonction
 * de bloquer la requête.
 * @param {import('express').Request} req
 * @param {string} [authToken] token du garage résolu ; sinon le token maître
 */
function isSignatureValid(req, authToken) {
  if (String(VALIDATE_TWILIO_SIGNATURE).toLowerCase() !== 'true') return true;

  const token = authToken || TWILIO_AUTH_TOKEN;
  if (!token) return true;

  const signature = req.get('X-Twilio-Signature');
  if (!signature) return true;

  const url = `${(PUBLIC_URL || '').replace(/\/$/, '')}${req.originalUrl}`;
  return twilio.validateRequest(token, signature, url, req.body || {});
}

module.exports = { sendWhatsApp, isSignatureValid, isConfigured };
