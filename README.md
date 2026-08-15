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
    ├── services/twilio.js     # Envoi sortant Twilio + validation de signature
    ├── services/meta.js       # Envoi sortant WhatsApp Cloud API
    ├── routes/admin.js        # CRUD /admin/cars (clé x-admin-key)
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

## Interface web d'administration

`http://localhost:3000/admin` — page unique (Tailwind CDN, sans build) : connexion par la clé `ADMIN_API_KEY`, compteurs disponible/réservée/vendue, tableau du stock, formulaire d'ajout, changement de statut et suppression en un clic. La clé est gardée en `sessionStorage` et envoyée à chaque appel dans `x-admin-key`.

## API d'admin (gestion du stock)

Protégé par l'en-tête `x-admin-key` (= `ADMIN_API_KEY` du `.env`).

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/admin/cars?status=available` | Lister le stock |
| `POST` | `/admin/cars` | Ajouter un véhicule (objet **ou** tableau) |
| `PATCH` | `/admin/cars/:id` | Modifier (ex. passer en `sold`) |
| `DELETE` | `/admin/cars/:id` | Supprimer |

```bash
curl -X POST http://localhost:3000/admin/cars \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"brand":"Toyota","model":"Yaris","year":2020,"price":13500,"mileage":52000,"fuel":"Hybride","description":"Yaris hybride 116h Dynamic"}'

curl -X PATCH http://localhost:3000/admin/cars/4 \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"status":"sold"}'
```

Champs obligatoires : `brand`, `model`, `year`, `price`, `mileage`, `fuel`. `status` ∈ `available|reserved|sold`. Un véhicule non `available` n'est plus proposé par l'agent.

## Brancher WhatsApp (vrais messages)

### Twilio (le plus rapide)

1. Console Twilio > Messaging > Try it out > **Send a WhatsApp message** : rejoindre la sandbox depuis ton téléphone (`join <code>` au +1 415 523 8886).
2. Renseigner dans `.env` : `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=+14155238886`.
3. Exposer le serveur : `ngrok http 3000` → copier l'URL `https://xxxx.ngrok-free.app`.
4. Sandbox settings > **When a message comes in** : `https://xxxx.ngrok-free.app/webhook`, méthode `POST`. Sauvegarder.
5. Envoyer un message WhatsApp au numéro sandbox : l'agent répond.

Deux modes de réponse (`REPLY_MODE`) :
- `twiml` (défaut) — la réponse part dans la réponse HTTP du webhook, aucun appel API, aucune clé requise ;
- `api` — envoi explicite via l'API Twilio (`client.messages.create`), utile pour les messages proactifs/relances.

En production, mettre `PUBLIC_URL=https://ton-domaine` et `VALIDATE_TWILIO_SIGNATURE=true` : les requêtes non signées par Twilio sont rejetées (403).

### Meta / WhatsApp Cloud API

Callback URL = `https://xxxx.ngrok-free.app/webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`. Renseigner `WHATSAPP_TOKEN` et `WHATSAPP_PHONE_NUMBER_ID` : le webhook accuse réception en 200 puis envoie la réponse via l'API Graph.

## Déploiement gratuit sur Render

1. Render.com > **New > Blueprint** > choisir le repo : `render.yaml` est détecté (plan free, région Frankfurt, healthcheck sur `/`).
2. Saisir les variables `sync: false` : `SUPABASE_URL`, `SUPABASE_KEY`, `GROQ_API_KEY` (+ Twilio si utilisé). `ADMIN_API_KEY` est générée automatiquement — la récupérer dans Environment pour se connecter à `/admin`.
3. Déployer, puis mettre `https://<ton-service>.onrender.com/webhook` comme webhook Twilio, et `PUBLIC_URL` + `VALIDATE_TWILIO_SIGNATURE=true` en prod.

Alternative Docker (Railway, Fly.io, VPS) : `Dockerfile` fourni.

```bash
docker build -t whatsapp-car-agent .
docker run --env-file .env -p 3000:3000 whatsapp-car-agent
```

Note : le plan free Render met le service en veille après inactivité — le premier message WhatsApp peut mettre ~30 s à recevoir une réponse.
