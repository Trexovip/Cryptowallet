# Turnkey image: everything needed to build better-sqlite3 and run the app.
FROM node:20-bookworm-slim

WORKDIR /app

# build tools so the SQLite native module compiles reliably on any host
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# app source
COPY . .

ENV HOST=0.0.0.0 \
    PORT=8000 \
    CUSTODY_DATA_DIR=/app/data

EXPOSE 8000
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
