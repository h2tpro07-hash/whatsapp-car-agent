/**
 * Accès Supabase via le client officiel @supabase/supabase-js.
 * Compatible avec les deux formats de clé : `sb_secret_...` (nouveau) et JWT `eyJ...` (legacy).
 */
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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
      'Vérifie SUPABASE_URL (URL REST du projet) et que le projet Supabase est actif.'
  );
}

/**
 * Vérifie la connexion au démarrage (log uniquement, ne bloque pas le serveur).
 */
async function checkConnection() {
  try {
    await run(supabase.from('cars').select('id').limit(1));
    return { ok: true, url: SUPABASE_URL };
  } catch (err) {
    return { ok: false, url: SUPABASE_URL, error: err.message };
  }
}

/**
 * Cherche les véhicules disponibles correspondant à des mots-clés.
 * @param {string[]} keywords ex: ['peugeot', '208']
 * @param {number} limit
 * @returns {Promise<Array>} lignes de la table `cars`
 */
async function findCars(keywords, limit = 3) {
  let query = supabase.from('cars').select('*').eq('status', 'available').limit(limit);

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
 * Fallback : le catalogue disponible le plus récent (si aucun modèle détecté).
 */
async function listAvailableCars(limit = 3) {
  const data = await run(
    supabase
      .from('cars')
      .select('*')
      .eq('status', 'available')
      .order('created_at', { ascending: false })
      .limit(limit)
  );
  return data || [];
}

module.exports = { supabase, run, checkConnection, findCars, listAvailableCars, SUPABASE_URL };
