# Livery: no dependencies beyond Node itself.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js core.js providers.js webpush.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/db.json TRUST_PROXY=1
# Keep /data on a persistent disk: it holds every company, trip and login.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
