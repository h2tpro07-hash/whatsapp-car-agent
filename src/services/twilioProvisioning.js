/**
 * Provisioning d'un numéro WhatsApp dédié par garage : crée un sous-compte
 * Twilio sous le compte maître (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN), y
 * achète un numéro français, et le configure sur le webhook partagé.
 *
 * Achat du numéro = automatisable par API. L'activation du numéro comme
 * expéditeur WhatsApp (profil d'entreprise, validation Meta) ne l'est pas
 * forcément instantanément côté Twilio : `garage_whatsapp_numbers.status`
 * reste `pending` jusqu'à confirmation manuelle dans la Console Twilio.
 */
const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;

const isConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && PUBLIC_URL);

/**
 * Crée un sous-compte Twilio dédié à un garage, y achète un numéro FR local,
 * et le pointe vers le webhook partagé `/webhook`.
 * @param {{id: string, name: string}} garage
 * @returns {Promise<{accountSid: string, authToken: string, whatsappNumber: string}>}
 */
async function provisionGarageNumber(garage) {
  if (!isConfigured) {
    throw new Error(
      'Provisioning Twilio non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / PUBLIC_URL manquants)'
    );
  }

  const masterClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const subaccount = await masterClient.api.v2010.accounts.create({
    friendlyName: `Garage: ${garage.name} (${garage.id})`,
  });

  const subClient = twilio(subaccount.sid, subaccount.authToken);

  const available = await subClient.availablePhoneNumbers('FR').local.list({
    smsEnabled: true,
    voiceEnabled: true,
    limit: 5,
  });

  if (!available.length) {
    throw new Error("Aucun numéro français disponible chez Twilio pour le moment");
  }

  const purchased = await subClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: `${PUBLIC_URL.replace(/\/$/, '')}/webhook`,
    smsMethod: 'POST',
  });

  return {
    accountSid: subaccount.sid,
    authToken: subaccount.authToken,
    whatsappNumber: purchased.phoneNumber,
  };
}

module.exports = { provisionGarageNumber, isConfigured };
