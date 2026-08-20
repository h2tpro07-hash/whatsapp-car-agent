/**
 * Couche WhatsApp : normalisation de l'entrant + formatage du sortant.
 * Compatible Twilio (form-urlencoded) ET WhatsApp Business API / Meta (JSON).
 */

/**
 * Extrait { from, to, body, channel } quelle que soit la source. `to` est
 * le numéro WhatsApp appelé par le client — utilisé pour résoudre à quel
 * garage ce message est destiné (voir services/tenant.js).
 * @param {import('express').Request} req
 */
function parseIncoming(req) {
  const b = req.body || {};

  // 1) Twilio : { From: 'whatsapp:+33...', To: 'whatsapp:+33...', Body: 'texte' }
  if (b.Body || b.From) {
    return {
      channel: 'twilio',
      from: (b.From || '').replace('whatsapp:', ''),
      to: (b.To || '').replace('whatsapp:', ''),
      body: b.Body || '',
    };
  }

  // 2) Meta WhatsApp Cloud API
  const msg = b.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (msg) {
    return {
      channel: 'meta',
      from: msg.from || '',
      to: b.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number || '',
      body: msg.text?.body || '',
    };
  }

  // 3) Test manuel (cURL / Postman) : { from, to, message }
  return {
    channel: 'test',
    from: b.from || 'test-user',
    to: b.to || '',
    body: b.message || b.text || '',
  };
}

/** Échappe les caractères XML pour la réponse TwiML. */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Réponse TwiML attendue par Twilio sur le webhook. */
function toTwiml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escapeXml(text)}</Message></Response>`;
}

/**
 * Nettoyage du texte pour WhatsApp : pas de markdown `**`, gras = *texte*.
 */
function formatForWhatsApp(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { parseIncoming, toTwiml, formatForWhatsApp };
