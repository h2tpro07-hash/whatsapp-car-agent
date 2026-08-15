/**
 * Moteur IA : Groq (Llama 3) via le SDK officiel `groq-sdk`
 * (API compatible OpenAI : chat.completions.create).
 */
const Groq = require('groq-sdk');

const { GROQ_API_KEY, GROQ_MODEL } = process.env;

if (!GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY est obligatoire (voir .env.example)');
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const MODEL = GROQ_MODEL || 'llama-3.1-8b-instant';

/** Met les données Supabase en texte lisible par le modèle. */
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

/**
 * Génère la réponse commerciale.
 * @param {string} customerMessage message du prospect
 * @param {Array} cars véhicules trouvés en base
 * @returns {Promise<string>}
 */
async function generateReply(customerMessage, cars) {
  const systemPrompt = `Tu es un vendeur automobile professionnel et courtois pour un garage indépendant. Réponds en 2 phrases maximum à la question du client en te basant UNIQUEMENT sur ces données du véhicule :
${formatCarsForPrompt(cars)}

Si le client semble très intéressé ou demande à voir le véhicule, demande-lui ses disponibilités pour un rendez-vous d'essai. N'invente jamais une information absente des données. Si aucun véhicule ne correspond, dis-le simplement et propose de rappeler le client dès qu'un modèle similaire arrive. Réponds en français.`;

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

module.exports = { generateReply, formatCarsForPrompt };
