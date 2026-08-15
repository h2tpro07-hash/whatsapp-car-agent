# Agent WhatsApp — marchand de voitures d'occasion

Express + Supabase (PostgreSQL) + Groq (Llama 3). Zéro service payant hors API.

## Structure

```
whatsapp-car-agent/
├── server.js                  # Serveur Express + route POST /webhook
├── package.json
├── .env.example
├── sql/schema.sql             # Table cars + 3 véhicules de test
└── src/
    ├── services/supabase.js   # Requêtes véhicules
    ├── services/ai.js         # Prompt système + appel Groq
    ├── services/whatsapp.js   # Parsing entrant (Twilio/Meta) + TwiML + formatage
    └── utils/extract.js       # Extraction des mots-clés (marque/modèle)
```

## a) Installer les dépendances

```bash
cd whatsapp-car-agent
npm install
cp .env.example .env   # puis remplir SUPABASE_URL, SUPABASE_KEY, GROQ_API_KEY
```

Clés : Supabase → Settings > API (utiliser la clé `service_role`). Groq → https://console.groq.com/keys.

## Base de données

Supabase > SQL Editor > coller `sql/schema.sql` > Run. Cela crée la table `cars`, les index, active RLS et insère la Peugeot 208, la Golf 7 et la Clio 5.

## b) Lancer en local

```bash
npm start        # ou: npm run dev  (rechargement auto, Node >= 18)
# -> Serveur démarré sur http://localhost:3000
```

## c) Tester le webhook sans WhatsApp

Format « test » (JSON simple) :

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"from":"+33600000000","message":"Bonjour, la Peugeot 208 est encore disponible ? Quel prix ?"}'
```

Réponse :

```json
{
  "reply": "Oui, la Peugeot 208 de 2019 est disponible à 11 990 € ...",
  "keywords": ["peugeot", "208"],
  "cars": [{ "id": 1, "brand": "Peugeot", "model": "208" }]
}
```

Simuler Twilio (form-urlencoded, réponse TwiML XML) :

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "From=whatsapp:+33600000000" \
  --data-urlencode "Body=Je voudrais voir la Golf 7, c'est possible cette semaine ?"
```

Dans Postman : `POST http://localhost:3000/webhook`, body `raw / JSON` = `{"message":"..."}`.

## Brancher WhatsApp

- **Twilio** : exposer le port (`ngrok http 3000`) puis mettre `https://xxxx.ngrok.io/webhook` dans Sandbox WhatsApp > "When a message comes in" (POST). Le serveur renvoie directement le TwiML, rien d'autre à faire.
- **Meta Cloud API** : même URL en Callback URL, `WHATSAPP_VERIFY_TOKEN` dans `.env` pour la vérification `GET /webhook` (l'envoi sortant se fait alors via l'API Graph).
