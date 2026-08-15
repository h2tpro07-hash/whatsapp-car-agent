/**
 * Extraction ultra simple (zéro dépendance, zéro appel IA) des mots-clés
 * véhicule contenus dans le message du prospect.
 */

// Mots vides français/anglais à ignorer.
const STOP_WORDS = new Set([
  'bonjour', 'salut', 'bonsoir', 'merci', 'svp', 'stp', 'le', 'la', 'les', 'un', 'une', 'des',
  'du', 'de', 'da', 'et', 'ou', 'est', 'ce', 'cet', 'cette', 'votre', 'vos', 'mon', 'ma', 'je',
  'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'pour', 'avec', 'sur', 'dans', 'que', 'qui', 'quoi',
  'combien', 'prix', 'coute', 'coûte', 'dispo', 'disponible', 'encore', 'toujours', 'voiture',
  'vehicule', 'véhicule', 'auto', 'bonjours', 'hello', 'hi', 'the', 'is', 'available', 'km',
  'kilometrage', 'kilométrage', 'annee', 'année', 'en', 'a', 'à', 'au', 'aux', 'me', 'moi',
  'avez', 'avoir', 'voir', 'essai', 'essayer', 'rdv', 'rendez', 'vous',
]);

/**
 * @param {string} message message brut WhatsApp
 * @returns {string[]} mots-clés candidats (marque, modèle, millésime…)
 */
function extractKeywords(message) {
  if (!message) return [];

  const tokens = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // supprime les accents
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const keywords = tokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  // Dédoublonnage en conservant l'ordre, max 4 mots-clés.
  return [...new Set(keywords)].slice(0, 4);
}

module.exports = { extractKeywords };
