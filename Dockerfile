FROM node:20-alpine

WORKDIR /app

# Dépendances d'abord : meilleur cache Docker
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Réseaux sans IPv6 : évite les `TypeError: fetch failed` vers Supabase.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 3000

CMD ["node", "server.js"]
