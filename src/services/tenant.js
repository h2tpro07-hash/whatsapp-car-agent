/**
 * Résolution du garage destinataire d'un message WhatsApp entrant.
 *
 * 1. Cherche un garage ayant un numéro dédié correspondant au `to` appelé
 *    (table `garage_whatsapp_numbers`, provisionné en Phase 2) — retourne
 *    alors aussi les identifiants du sous-compte Twilio de ce garage.
 * 2. À défaut (garage pilote, ou pas encore provisionné), retombe sur
 *    DEFAULT_GARAGE_ID : ce garage utilise le compte Twilio maître (unique
 *    numéro configuré via .env), comportement historique inchangé.
 */
const { supabase, run } = require('./supabase');

const numberCache = new Map(); // to -> { garage, at }
let defaultGarageCache = null;
let defaultGarageCachedAt = 0;
const CACHE_MS = 60_000;

/** Normalise un numéro E.164 (retire le préfixe `whatsapp:` éventuel). */
function normalizeNumber(number) {
  return String(number || '').replace('whatsapp:', '').trim();
}

async function resolveByNumber(toNumber) {
  const cached = numberCache.get(toNumber);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.garage;

  const row = await run(
    supabase
      .from('garage_whatsapp_numbers')
      .select('twilio_account_sid, twilio_auth_token, garages(id, name, vertical, status, ai_persona_overrides)')
      .eq('whatsapp_number', toNumber)
      .eq('status', 'active')
      .maybeSingle()
  );

  if (!row || !row.garages) return null;

  const garage = {
    ...row.garages,
    twilioAccountSid: row.twilio_account_sid,
    twilioAuthToken: row.twilio_auth_token,
    whatsappFrom: toNumber,
  };
  numberCache.set(toNumber, { garage, at: Date.now() });
  return garage;
}

async function resolveDefaultGarage() {
  if (defaultGarageCache && Date.now() - defaultGarageCachedAt < CACHE_MS) return defaultGarageCache;

  const garageId = String(process.env.DEFAULT_GARAGE_ID || '').trim();
  if (!garageId) throw new Error('DEFAULT_GARAGE_ID non configuré (voir .env.example)');

  const garage = await run(
    supabase
      .from('garages')
      .select('id, name, vertical, status, ai_persona_overrides')
      .eq('id', garageId)
      .maybeSingle()
  );
  if (!garage) throw new Error(`Garage introuvable pour DEFAULT_GARAGE_ID=${garageId}`);

  defaultGarageCache = garage;
  defaultGarageCachedAt = Date.now();
  return garage;
}

/**
 * @param {string} [toNumber] numéro WhatsApp appelé (champ `To` Twilio)
 * @returns {Promise<{id: string, name: string, vertical: string, status: string, ai_persona_overrides: object, twilioAccountSid?: string, twilioAuthToken?: string}>}
 */
async function resolveWebhookGarage(toNumber) {
  const normalized = normalizeNumber(toNumber);
  if (normalized) {
    const garage = await resolveByNumber(normalized);
    if (garage) return garage;
  }
  return resolveDefaultGarage();
}

module.exports = { resolveWebhookGarage };
