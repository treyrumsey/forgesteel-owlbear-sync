# The Sync Steel api. Build from the repository root:
#   docker build -f server/Dockerfile .

# The hero summary bundle: the fork's HeroSummaryLogic and upstream's HeroLogic as one ESM file
# (vite.sync-steel-summary.config.ts). Node can't run src/ directly, so the api loads this instead.
FROM node:26-slim AS summary
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json vite.config.ts vite.sync-steel-summary.config.ts ./
COPY src ./src
RUN npx vite build --config vite.sync-steel-summary.config.ts

FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app/server

COPY server/package.json server/package-lock.json server/.npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY --from=summary /app/server/build ./build

# Node runs the TypeScript directly. The database lives on the volume at DATABASE_PATH.
EXPOSE 8787
CMD ["node", "src/main.ts"]
