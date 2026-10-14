# One digest-pinned Node 22 / Debian bookworm image for every Railway service.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# Must match the Railway Postgres major (ghcr.io/railwayapp-templates/postgres-ssl:18):
# pg_dump refuses to dump a newer server ("aborting because of server version mismatch").
ARG PG_CLIENT_VERSION=18.6-1.pgdg12+2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && mkdir -p /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18="${PG_CLIENT_VERSION}" poppler-utils \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PATH="/usr/lib/postgresql/18/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node services ./services
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
# Owner rulings files are inputs to scripts/apply-ownership.js (run as a one-off on migrate).
COPY --chown=node:node docs/rulings ./docs/rulings
USER node
CMD ["node", "services/app/index.js"]
