/**
 * Accès Supabase : recherche des véhicules.
 */
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Node < 22 n'expose pas WebSocket globalement, requis par @supabase/realtime-js.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

const { SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL et SUPABASE_KEY sont obligatoires (voir .env.example)');
}

// Client backend : pas de session utilisateur à persister.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Node < 22 n'a pas de WebSocket natif, requis par le module realtime.
  realtime: { transport: ws },
});

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

  const { data, error } = await query;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data || [];
}

/**
 * Fallback : le catalogue disponible le plus récent (si aucun modèle détecté).
 */
async function listAvailableCars(limit = 3) {
  const { data, error } = await supabase
    .from('cars')
    .select('*')
    .eq('status', 'available')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Supabase: ${error.message}`);
  return data || [];
}

module.exports = { supabase, findCars, listAvailableCars };
