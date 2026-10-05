# syntax=docker/dockerfile:1
# Imagen de la API para Render. Render inyecta PORT; DATABASE_URL y NODE_ENV se configuran
# en el panel del servicio. Esta imagen no lleva credenciales.
#
#   docker build -t quinde-vuelos-api .
#   docker run --rm -p 3000:3000 -e PORT=3000 -e NODE_ENV=production \
#     -e DATABASE_URL="postgresql://...?schema=vuelos" quinde-vuelos-api

ARG NODE_VERSION=22

# --- 1. compilación: dependencias completas, cliente de Prisma y dist/ ---------
FROM node:${NODE_VERSION}-bookworm-slim AS compilacion
WORKDIR /app

# El postinstall corre "prisma generate", que necesita el esquema y su configuración.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- 2. ejecución: solo dependencias de producción y lo compilado --------------
FROM node:${NODE_VERSION}-bookworm-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app

# --ignore-scripts: el cliente de Prisma ya viene compilado en dist/generated, y husky y
# el CLI de prisma son dependencias de desarrollo.
# --omit=optional: @prisma/client declara prisma y typescript como peers opcionales y npm
# los marca devOptional; sin esto entran ~250 MB del CLI. El único opcional real es
# pg-cloudflare, que solo sirve en Cloudflare Workers.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY --from=compilacion /app/dist ./dist
# Ícono de Swagger (se lee al arrancar)
COPY docs/logo-icono.svg ./docs/logo-icono.svg

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/flights/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
