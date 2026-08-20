/**
 * Accès Supabase via le client officiel @supabase/supabase-js.
 * Compatible avec les deux formats de clé : `sb_secret_...` (nouveau) et JWT `eyJ...` (legacy).
 */
const dns = require('dns');

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Sur Render (et tout hôte sans sortie IPv6), l'AAAA de Supabase est injoignable
// et `fetch` échoue en `TypeError: fetch failed` : on privilégie l'IPv4.
// Répété ici pour les scripts qui chargent ce module sans passer par server.js.
dns.setDefaultResultOrder('ipv4first');

// Node < 22 n'expose pas WebSocket globalement, requis par @supabase/realtime-js.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

/**
 * Normalise l'URL du projet : espaces / retours à la ligne collés depuis le dashboard,
 * schéma manquant, slash final, ou URL de connexion Postgres fournie par erreur.
 */
function normalizeUrl(raw) {
  let value = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error('SUPABASE_URL est vide (voir .env.example)');

  if (value.startsWith('postgres://') || value.startsWith('postgresql://')) {
    throw new Error(
      "SUPABASE_URL doit être l'URL REST du projet (https://xxxx.supabase.co), pas une chaîne de connexion Postgres"
    );
  }

  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`SUPABASE_URL invalide : "${raw}"`);
  }

  return parsed.origin;
}

const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL);
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || '').trim();

if (!SUPABASE_KEY) {
  throw new Error('SUPABASE_KEY est obligatoire (clé service_role ou sb_secret_..., voir .env.example)');
}

// Client backend : pas de session utilisateur à persister.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Node < 22 n'a pas de WebSocket natif, requis par le module realtime.
  realtime: { transport: ws },
});

/**
 * Exécute une requête du client Supabase et transforme les erreurs réseau
 * (`TypeError: fetch failed`) en message exploitable.
 * @template T
 * @param {PromiseLike<{data: T, error: any}>} query
 * @returns {Promise<T>}
 */
async function run(query) {
  // Une panne réseau remonte soit en exception, soit dans `error` selon la version du SDK.
  let result;
  try {
    result = await query;
  } catch (err) {
    throw networkError(err);
  }

  if (result.error) {
    const message = String(result.error.message || '');
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
      throw networkError(result.error);
    }
    throw new Error(`Supabase: ${message}`);
  }

  return result.data;
}

/** Erreur réseau : DNS, TLS, projet en pause, sortie réseau bloquée. */
function networkError(err) {
  const cause = err.cause?.cause?.code || err.cause?.code || err.code || err.message;
  return new Error(
    `Connexion à Supabase impossible (${SUPABASE_URL}) : ${cause}. ` +
      'Vérifie SUPABASE_URL (URL REST du projet), que le projet Supabase est actif, ' +
      'et sur un hôte sans IPv6 que NODE_OPTIONS=--dns-result-order=ipv4first est bien pris en compte.'
  );
}

/**
 * Vérifie la connexion au démarrage (log uniquement, ne bloque pas le serveur).
 */
async function checkConnection() {
  try {
    await run(supabase.from('garages').select('id').limit(1));
    return { ok: true, url: SUPABASE_URL };
  } catch (err) {
    return { ok: false, url: SUPABASE_URL, error: err.message };
  }
}

/**
 * Cherche les véhicules disponibles d'un garage correspondant à des mots-clés.
 * @param {string} garageId
 * @param {string[]} keywords ex: ['peugeot', '208']
 * @param {number} limit
 * @returns {Promise<Array>} lignes de la table `cars`
 */
async function findCars(garageId, keywords, limit = 3) {
  let query = supabase
    .from('cars')
    .select('*')
    .eq('garage_id', garageId)
    .eq('status', 'available')
    .limit(limit);

  if (keywords.length > 0) {
    // OR sur marque + modèle pour chaque mot-clé : brand.ilike.%208%,model.ilike.%208%,...
    const filter = keywords
      .flatMap((k) => [`brand.ilike.%${k}%`, `model.ilike.%${k}%`])
      .join(',');
    query = query.or(filter);
  }

  return (await run(query)) || [];
}

/**
 * Fallback : le catalogue disponible le plus récent d'un garage (si aucun modèle détecté).
 */
async function listAvailableCars(garageId, limit = 3) {
  const data = await run(
    supabase
      .from('cars')
      .select('*')
      .eq('garage_id', garageId)
      .eq('status', 'available')
      .order('created_at', { ascending: false })
      .limit(limit)
  );
  return data || [];
}

/**
 * Cherche dans le catalogue de services actifs d'un garage (métier réparation).
 * @param {string} garageId
 * @param {string[]} keywords
 * @param {number} limit
 * @returns {Promise<Array>} lignes de la table `services`
 */
async function findServices(garageId, keywords, limit = 5) {
  let query = supabase.from('services').select('*').eq('garage_id', garageId).eq('active', true).limit(limit);

  if (keywords.length > 0) {
    const filter = keywords.map((k) => `name.ilike.%${k}%`).join(',');
    query = query.or(filter);
  }

  return (await run(query)) || [];
}

/**
 * Fallback : le catalogue de services actifs d'un garage (si aucune correspondance).
 */
async function listServices(garageId, limit = 5) {
  const data = await run(
    supabase.from('services').select('*').eq('garage_id', garageId).eq('active', true).order('name').limit(limit)
  );
  return data || [];
}

/**
 * Journalise une demande de rendez-vous (métier réparation) : regroupe les
 * messages d'un même client encore "en attente" plutôt que de créer une ligne
 * par message, pour donner au staff un dossier client lisible dans l'admin.
 * L'IA ne confirme jamais un créneau elle-même — c'est le staff qui le fait.
 * @param {string} garageId
 * @param {string} customerPhone
 * @param {string} message texte brut du client
 * @param {string|null} serviceId meilleure correspondance de service, si trouvée
 */
async function logAppointmentRequest(garageId, customerPhone, message, serviceId) {
  const existing = await run(
    supabase
      .from('appointments')
      .select('id, notes')
      .eq('garage_id', garageId)
      .eq('customer_phone', customerPhone)
      .eq('status', 'requested')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );

  if (existing) {
    const notes = `${existing.notes || ''}\n${message}`.trim();
    const update = { notes };
    if (serviceId) update.service_id = serviceId;
    await run(supabase.from('appointments').update(update).eq('id', existing.id));
    return;
  }

  await run(
    supabase.from('appointments').insert({
      garage_id: garageId,
      service_id: serviceId || null,
      customer_phone: customerPhone,
      notes: message,
      status: 'requested',
    })
  );
}

module.exports = {
  supabase,
  run,
  checkConnection,
  findCars,
  listAvailableCars,
  findServices,
  listServices,
  logAppointmentRequest,
  SUPABASE_URL,
};
