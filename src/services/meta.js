/**
 * Envoi sortant via WhatsApp Cloud API (Meta).
 * Utilisé uniquement si WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID sont définis.
 */
const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION } = process.env;

const isConfigured = Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
const VERSION = WHATSAPP_API_VERSION || 'v21.0';

/**
 * @param {string} to numéro international sans '+' (ex: 33600000000)
 * @param {string} body texte du message
 */
async function sendWhatsApp(to, body) {
  if (!isConfigured) {
    throw new Error('Meta non configuré (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }

  const res = await fetch(`https://graph.facebook.com/${VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(to).replace('+', ''),
      type: 'text',
      text: { body },
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Meta API: ${JSON.stringify(json)}`);
  return json;
}

module.exports = { sendWhatsApp, isConfigured };
