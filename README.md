# Agent WhatsApp — multi-garages (vente & réparation)

Express + Supabase (PostgreSQL + Auth) + Groq (Llama 3). Plateforme **multi-garages** : chaque garage a son métier (vente de véhicules d'occasion ou réparation/mécanique), son compte admin, ses données isolées. Zéro service payant hors API.

> **État actuel (v2, Phase 0+1)** : le modèle de données, l'authentification et les deux métiers sont multi-tenant. Un seul numéro WhatsApp par déploiement reste branché sur un garage désigné par `DEFAULT_GARAGE_ID` — le routing d'un numéro Twilio dédié par garage et la facturation Stripe arrivent dans une phase suivante.

## Structure

```
whatsapp-car-agent/
├── server.js                     # Serveur Express + route POST /webhook (résout le garage, branche vente/réparation)
├── package.json
├── .env.example
├── sql/
│   ├── schema.sql                # Schéma complet multi-garages (projet neuf) + données de démo
│   └── migrate_v2_multi_tenant.sql  # Migration pour un projet v1 existant (mono-garage -> multi-garages)
└── src/
    ├── services/supabase.js      # Requêtes véhicules (vente) et services/RDV (réparation), scopées par garage_id
    ├── services/ai.js            # Prompt système par métier (vente / réparation) + appel Groq
    ├── services/auth.js          # Vérifie le JWT Supabase Auth, résout le garage de l'utilisateur connecté
    ├── services/tenant.js        # Résout le garage destinataire d'un message WhatsApp entrant
    ├── services/whatsapp.js      # Parsing entrant (Twilio/Meta) + TwiML + formatage
    ├── services/twilio.js        # Envoi sortant Twilio + validation de signature
    ├── services/meta.js          # Envoi sortant WhatsApp Cloud API
    ├── routes/admin.js           # CRUD /admin/{cars|services|appointments|quotes}, scopé par garage
    └── utils/extract.js          # Extraction des mots-clés (marque/modèle, ou nom de service)
```

## a) Installer les dépendances

```bash
cd whatsapp-car-agent
npm install
cp .env.example .env   # puis remplir SUPABASE_URL, SUPABASE_KEY, SUPABASE_ANON_KEY, GROQ_API_KEY, DEFAULT_GARAGE_ID
```

Clés Supabase (Settings > API) :
- `SUPABASE_KEY` = clé **service_role** (backend uniquement, jamais exposée).
- `SUPABASE_ANON_KEY` = clé **anon/publishable**, prévue pour être publique — utilisée par le navigateur (page `/admin`) pour l'authentification.

Groq → https://console.groq.com/keys.

## Base de données

**Projet neuf** : Supabase > SQL Editor > coller `sql/schema.sql` > Run. Cela crée toutes les tables multi-garages (`garages`, `cars`, `services`, `appointments`, `quotes`, ...), active RLS et insère deux garages de démonstration (un par métier). Le script affiche leurs UUID en `NOTICE` — copiez-en un dans `DEFAULT_GARAGE_ID`.

**Projet existant (v1 mono-garage)** : utilisez `sql/migrate_v2_multi_tenant.sql` à la place. Il rattache votre table `cars` existante à un garage "pilote" nouvellement créé et affiche son UUID pour `DEFAULT_GARAGE_ID`.

### Créer votre premier compte admin

L'ancienne clé partagée `ADMIN_API_KEY` a été remplacée par de vrais comptes (Supabase Auth). Étape unique, à faire une fois par garage :
1. Supabase Dashboard > Authentication > Users > **Add user** (email + mot de passe).
2. Copier l'UUID généré, puis dans le SQL Editor :
   ```sql
   insert into public.garage_members (garage_id, user_id, role)
   values ('<UUID du garage>', '<UUID utilisateur>', 'owner');
   ```
3. Se connecter sur `/admin` avec cet email/mot de passe.

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

Pour un garage `reparation`, la réponse renvoie `services` au lieu de `cars` :

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"from":"+33600000000","message":"Bonjour, combien coute une vidange ?"}'
```

## Interface web d'administration

`http://localhost:3000/admin` — page unique (Tailwind CDN, sans build) : connexion par email/mot de passe (Supabase Auth). L'écran s'adapte automatiquement au métier du garage connecté :
- **vente** : compteurs disponible/réservée/vendue, tableau du stock, formulaire d'ajout, changement de statut et suppression en un clic (comportement identique à la v1) ;
- **réparation** : catalogue de services (ajout, activation/désactivation, suppression) et liste des demandes de rendez-vous (le client écrit sur WhatsApp, la demande apparaît ici ; le staff confirme le créneau et le statut — l'IA ne confirme jamais un rendez-vous elle-même).

## API d'admin

Protégé par un token Supabase Auth (`Authorization: Bearer <access_token>`), résolu automatiquement en `garage_id` côté serveur — chaque garage ne voit et ne modifie que ses propres données.

| Méthode | Route | Métier | Rôle |
| --- | --- | --- | --- |
| `GET` | `/admin/me` | — | Infos du garage connecté (nom, métier, statut) |
| `GET` | `/admin/cars?status=available` | vente | Lister le stock |
| `POST` | `/admin/cars` | vente | Ajouter un véhicule (objet **ou** tableau) |
| `PATCH` | `/admin/cars/:id` | vente | Modifier (ex. passer en `sold`) |
| `DELETE` | `/admin/cars/:id` | vente | Supprimer |
| `GET/POST/PATCH/DELETE` | `/admin/services[/:id]` | réparation | Catalogue de services |
| `GET/POST/PATCH/DELETE` | `/admin/appointments[/:id]` | réparation | Demandes de rendez-vous |
| `GET/POST/PATCH/DELETE` | `/admin/quotes[/:id]` | réparation | Devis |

```bash
TOKEN="<access_token obtenu après connexion>"

curl -X POST http://localhost:3000/admin/cars \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"brand":"Toyota","model":"Yaris","year":2020,"price":13500,"mileage":52000,"fuel":"Hybride","description":"Yaris hybride 116h Dynamic"}'

curl -X PATCH http://localhost:3000/admin/cars/4 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"status":"sold"}'
```

Champs obligatoires (véhicules) : `brand`, `model`, `year`, `price`, `mileage`, `fuel`. `status` ∈ `available|reserved|sold`. Un véhicule non `available` n'est plus proposé par l'agent.

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
2. Saisir les variables : `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_ANON_KEY`, `GROQ_API_KEY`, `DEFAULT_GARAGE_ID` (+ Twilio si utilisé).
3. Déployer, puis mettre `https://<ton-service>.onrender.com/webhook` comme webhook Twilio, et `PUBLIC_URL` + `VALIDATE_TWILIO_SIGNATURE=true` en prod.

Alternative Docker (Railway, Fly.io, VPS) : `Dockerfile` fourni.

```bash
docker build -t whatsapp-car-agent .
docker run --env-file .env -p 3000:3000 whatsapp-car-agent
```

Note : le plan free Render met le service en veille après inactivité — le premier message WhatsApp peut mettre ~30 s à recevoir une réponse.

## Feuille de route (multi-garages, abonnement mensuel)

Cette version (v2) livre les fondations multi-tenant : modèle de données par garage, authentification par compte, deux métiers configurables (vente / réparation). Les phases suivantes, à enchaîner une fois vos comptes Stripe/Twilio prêts :
- **Numéro WhatsApp dédié par garage** — un sous-compte Twilio + un numéro par garage, routage automatique des messages entrants selon le numéro appelé.
- **Facturation Stripe** — abonnement mensuel, coupure automatique de l'agent WhatsApp en cas d'impayé.
- **Inscription en ligne self-service** — un garage s'inscrit, paie, et reçoit son agent configuré sans intervention manuelle.
- **Panneau super-admin** — vue d'ensemble de tous les garages clients, actions manuelles de secours.
