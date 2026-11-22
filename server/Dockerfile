# The Sync Steel api. Build from the repository root, so later phases can import the fork's src/:
#   docker build -f server/Dockerfile .
FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app/server

COPY server/package.json server/package-lock.json server/.npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src

# Node runs the TypeScript directly. The database lives on the volume at DATABASE_PATH.
EXPOSE 8787
CMD ["node", "src/main.ts"]
