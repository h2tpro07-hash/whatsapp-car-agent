/**
 * Notifications email au garage (nouvelle demande de rendez-vous), via Resend.
 * Optionnel : sans RESEND_API_KEY/RESEND_FROM_EMAIL, les notifications sont
 * simplement désactivées (aucune erreur, juste un log au démarrage).
 */
const { RESEND_API_KEY, RESEND_FROM_EMAIL, PUBLIC_URL } = process.env;

const isConfigured = Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);

/**
 * Prévient le garage par email qu'un client souhaite un rendez-vous :
 * numéro du client, message reçu (contient souvent nom/créneau souhaité,
 * l'IA les ayant demandés), et un rappel clair à le recontacter.
 * @param {{ ownerEmail: string, garageName: string, customerPhone: string, message: string }} params
 */
async function notifyNewAppointmentRequest({ ownerEmail, garageName, customerPhone, message }) {
  if (!isConfigured || !ownerEmail) return;

  const adminLink = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/admin` : null;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: ownerEmail,
      subject: `📞 Nouvelle demande de rendez-vous — ${garageName}`,
      text: [
        `Un client souhaite un rendez-vous sur WhatsApp.`,
        ``,
        `Téléphone : ${customerPhone}`,
        `Message : "${message}"`,
        ``,
        `Merci de rappeler ce client pour confirmer le créneau (l'IA ne confirme jamais un rendez-vous elle-même).`,
        adminLink ? `` : null,
        adminLink ? `Voir toutes les demandes : ${adminLink}` : null,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[WARN] notification email échouée:', res.status, body);
  }
}

module.exports = { notifyNewAppointmentRequest, isConfigured };
