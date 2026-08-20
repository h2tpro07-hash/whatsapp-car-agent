/**
 * Moteur IA : Groq (Llama 3) via le SDK officiel `groq-sdk`
 * (API compatible OpenAI : chat.completions.create).
 * Le prompt système dépend du métier du garage (`vente` ou `reparation`).
 */
const Groq = require('groq-sdk');

const { GROQ_API_KEY, GROQ_MODEL } = process.env;

if (!GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY est obligatoire (voir .env.example)');
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const MODEL = GROQ_MODEL || 'openai/gpt-oss-20b';

/** Met les véhicules Supabase en texte lisible par le modèle. */
function formatCarsForPrompt(cars) {
  if (!cars.length) return 'AUCUN VÉHICULE CORRESPONDANT EN STOCK.';

  return cars
    .map(
      (c, i) =>
        `Véhicule ${i + 1} :
- Marque : ${c.brand}
- Modèle : ${c.model}
- Année : ${c.year}
- Prix : ${Number(c.price).toLocaleString('fr-FR')} €
- Kilométrage : ${Number(c.mileage).toLocaleString('fr-FR')} km
- Carburant : ${c.fuel}
- Description : ${c.description || 'n/a'}
- Statut : ${c.status}`
    )
    .join('\n\n');
}

/** Met le catalogue de services Supabase en texte lisible par le modèle. */
function formatServicesForPrompt(services) {
  if (!services.length) return 'AUCUN SERVICE CORRESPONDANT AU CATALOGUE.';

  const priceRange = (s) => {
    if (!s.price_min && !s.price_max) return 'sur devis';
    if (s.price_min && s.price_max && s.price_min !== s.price_max) {
      return `${Number(s.price_min).toLocaleString('fr-FR')} € - ${Number(s.price_max).toLocaleString('fr-FR')} €`;
    }
    return `${Number(s.price_min || s.price_max).toLocaleString('fr-FR')} €`;
  };

  return services
    .map(
      (s, i) =>
        `Service ${i + 1} :
- Nom : ${s.name}
- Description : ${s.description || 'n/a'}
- Prix indicatif : ${priceRange(s)}
- Durée estimée : ${s.duration_min ? `${s.duration_min} min` : 'n/a'}`
    )
    .join('\n\n');
}

/** Prompt système — métier vente (revendeur de véhicules d'occasion). */
function buildVenteSystemPrompt(garage, cars) {
  const name = garage?.name || 'un garage indépendant';
  return `Tu es un vendeur automobile professionnel et courtois pour ${name}. Réponds en 2 phrases maximum à la question du client en te basant UNIQUEMENT sur ces données du véhicule :
${formatCarsForPrompt(cars)}

Si le client semble très intéressé ou demande à voir le véhicule, demande-lui ses disponibilités pour un rendez-vous d'essai. N'invente jamais une information absente des données. Si aucun véhicule ne correspond, dis-le simplement et propose de rappeler le client dès qu'un modèle similaire arrive. Réponds en français.`;
}

/** Prompt système — métier réparation (garage mécanique). */
function buildReparationSystemPrompt(garage, services) {
  const name = garage?.name || 'un garage de réparation';
  return `Tu es le réceptionniste WhatsApp de ${name}, un garage de réparation automobile. Réponds en 2 à 3 phrases maximum à la question du client en te basant UNIQUEMENT sur ce catalogue de services :
${formatServicesForPrompt(services)}

Ton rôle : identifier le service recherché par le client, donner la fourchette de prix si elle est connue, puis demander ses disponibilités (jour et heure) et le modèle de son véhicule pour proposer un rendez-vous. Ne confirme JAMAIS toi-même un créneau de rendez-vous : dis que l'équipe le recontactera pour confirmer. N'invente jamais un service ou un prix absent du catalogue. Si aucun service ne correspond à sa demande, dis-le simplement et propose qu'un membre de l'équipe le rappelle. Réponds en français.`;
}

/**
 * Génère la réponse WhatsApp, avec le prompt adapté au métier du garage.
 * @param {{name: string, vertical: 'vente'|'reparation'}} garage
 * @param {string} customerMessage message du prospect
 * @param {Array} contextData véhicules (vente) ou services (réparation) trouvés en base
 * @returns {Promise<string>}
 */
async function generateReply(garage, customerMessage, contextData) {
  const systemPrompt =
    garage?.vertical === 'reparation'
      ? buildReparationSystemPrompt(garage, contextData)
      : buildVenteSystemPrompt(garage, contextData);

  const completion = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: customerMessage },
    ],
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "Désolé, je n'ai pas pu traiter votre demande. Pouvez-vous reformuler ?"
  );
}

module.exports = { generateReply, formatCarsForPrompt, formatServicesForPrompt };
