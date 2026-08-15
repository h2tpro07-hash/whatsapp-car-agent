/**
 * Envoi sortant Twilio (WhatsApp) + validation de signature des webhooks.
 * Optionnel : sans TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, le serveur
 * répond simplement en TwiML (aucun appel API nécessaire).
 */
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  PUBLIC_URL,
  VALIDATE_TWILIO_SIGNATURE,
} = process.env;

const isConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);

const client = isConfigured ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

/** Préfixe `whatsapp:` requis par Twilio. */
function toWhatsAppAddress(number) {
  const n = String(number).trim();
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n}`;
}

/**
 * Envoie un message WhatsApp via l'API Twilio (mode REPLY_MODE=api,
 * ou pour un message proactif type relance).
 * @param {string} to numéro destinataire (+33...)
 * @param {string} body texte
 */
async function sendWhatsApp(to, body) {
  if (!isConfigured) {
    throw new Error('Twilio non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM)');
  }
  const msg = await client.messages.create({
    from: toWhatsAppAddress(TWILIO_WHATSAPP_FROM),
    to: toWhatsAppAddress(to),
    body,
  });
  return { sid: msg.sid, status: msg.status };
}

/**
 * Middleware Express : rejette les requêtes qui ne viennent pas de Twilio.
 * Actif uniquement si VALIDATE_TWILIO_SIGNATURE=true.
 */
function verifyTwilioSignature(req, res, next) {
  if (String(VALIDATE_TWILIO_SIGNATURE).toLowerCase() !== 'true') return next();
  if (!TWILIO_AUTH_TOKEN) return next();

  // Ignorer les requêtes non-Twilio (tests JSON cURL/Postman).
  const signature = req.get('X-Twilio-Signature');
  if (!signature) return next();

  const url = `${(PUBLIC_URL || '').replace(/\/$/, '')}${req.originalUrl}`;
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {});

  if (!valid) {
    console.warn('[SECU] Signature Twilio invalide pour', url);
    return res.status(403).send('Invalid Twilio signature');
  }
  return next();
}

module.exports = { sendWhatsApp, verifyTwilioSignature, isConfigured };
