/**
 * Résolution du garage pour le webhook WhatsApp.
 *
 * Provisoire (v2 / Phase 1) : un seul numéro WhatsApp est branché sur ce
 * déploiement, donc le garage qui reçoit les messages est fixé par
 * DEFAULT_GARAGE_ID. La Phase 2 (un numéro Twilio dédié par garage)
 * remplacera ceci par une résolution dynamique à partir du numéro appelé
 * (`To` de la requête Twilio) — voir sql/schema.sql `garage_whatsapp_numbers`.
 */
const { supabase, run } = require('./supabase');

let cachedGarage = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

/** @returns {Promise<{id: string, name: string, vertical: string, status: string, ai_persona_overrides: object}>} */
async function resolveWebhookGarage() {
  if (cachedGarage && Date.now() - cachedAt < CACHE_MS) return cachedGarage;

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

  cachedGarage = garage;
  cachedAt = Date.now();
  return garage;
}

module.exports = { resolveWebhookGarage };
