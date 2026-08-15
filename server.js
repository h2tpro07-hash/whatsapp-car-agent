/**
 * Agent WhatsApp pour marchand de voitures d'occasion.
 * Flux : WhatsApp -> POST /webhook -> mots-clés -> Supabase -> Groq (Llama 3) -> réponse.
 */
require('dotenv').config();

const express = require('express');

const { findCars, listAvailableCars } = require('./src/services/supabase');
const { generateReply } = require('./src/services/ai');
const { extractKeywords } = require('./src/utils/extract');
const { parseIncoming, toTwiml, formatForWhatsApp } = require('./src/services/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio envoie du form-urlencoded, Meta et Postman du JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/** Healthcheck. */
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'whatsapp-car-agent' }));

/**
 * Vérification du webhook Meta (WhatsApp Cloud API).
 * Twilio n'en a pas besoin.
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Webhook principal : reçoit le message du prospect et renvoie la réponse du vendeur IA.
 */
app.post('/webhook', async (req, res) => {
  try {
    // 1. Normaliser l'entrant (Twilio / Meta / test cURL)
    const { channel, from, body } = parseIncoming(req);
    console.log(`[IN ] ${channel} ${from}: ${body}`);

    if (!body.trim()) {
      const empty = 'Bonjour ! Quel véhicule recherchez-vous ? (marque et modèle)';
      return channel === 'twilio'
        ? res.type('text/xml').send(toTwiml(empty))
        : res.json({ reply: empty, cars: [] });
    }

    // 2. Extraire les mots-clés (marque / modèle)
    const keywords = extractKeywords(body);

    // 3. Interroger Supabase (fallback : catalogue disponible)
    let cars = keywords.length ? await findCars(keywords) : [];
    if (cars.length === 0) cars = await listAvailableCars(3);

    // 4. Générer la réponse avec Groq à partir des seules données Supabase
    const aiText = await generateReply(body, cars);

    // 5. Formater pour WhatsApp
    const reply = formatForWhatsApp(aiText);
    console.log(`[OUT] ${from}: ${reply}`);

    // 6. Répondre dans le format attendu par le canal
    if (channel === 'twilio') {
      return res.type('text/xml').send(toTwiml(reply));
    }
    return res.json({
      reply,
      keywords,
      cars: cars.map((c) => ({ id: c.id, brand: c.brand, model: c.model })),
    });
  } catch (err) {
    console.error('[ERR]', err);
    const fallback =
      "Désolé, un problème technique est survenu. Un conseiller vous répondra très vite.";
    if ((req.body && req.body.Body) || (req.body && req.body.From)) {
      return res.type('text/xml').status(200).send(toTwiml(fallback));
    }
    return res.status(500).json({ error: err.message, reply: fallback });
  }
});

app.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));

module.exports = app;
