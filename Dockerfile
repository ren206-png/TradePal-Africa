# Single image, three run modes (`dist/src/server.js` for the webhook HTTP
# server, `dist/src/worker.js` for the inbound-message BullMQ consumer,
# `dist/src/subscriptionExpiryWorker.js` for the hourly subscription-expiry
# sweep) — see docker-compose.yml for how the three services share this image
# with different `command`s.

FROM node:20-slim AS builder
WORKDIR /app

# Install all deps (including the `prisma` CLI and `typescript`, both
# devDependencies) since this stage needs to generate the Prisma Client and
# compile TypeScript. package-lock.json is required for npm ci reproducibility.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generates node_modules/.prisma/client (query engine + JS) from schema.prisma
# — must run before `npm run build` compiles anything that imports it.
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Carries the full node_modules (including devDependencies) forward rather
# than re-running `npm ci --omit=dev`, specifically so the Prisma Client
# artifacts generated in the builder stage (node_modules/.prisma) don't need
# to be regenerated or selectively copied here — simpler and less fragile
# than reproducing `prisma generate` in a slimmed runtime stage, at the cost
# of a larger image. Revisit if image size becomes an actual constraint.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

EXPOSE 3000

# No default CMD: docker-compose.yml sets an explicit `command` per service
# (server vs worker vs subscription-expiry-worker) since all three run from
# this same image.
