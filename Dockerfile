# Shoal's API server (server/) for Railway or any Docker host. The website
# (web/) deploys separately on Vercel, which forwards /api/* here (see
# web/vercel.json). Settings and keys come from the host's environment
# variables, never from a file baked into the image.
FROM node:22-bookworm-slim

# git clones the teams' repos; Python runs Python projects' tests.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev
COPY server server
# The bundled demo repo ("Use the demo repo").
COPY demo-repo demo-repo

# Teams' tests run in here, so not as root. The server writes clones, the
# workspace and (without Supabase) its state under server/.
RUN mkdir -p server/.data server/.repos && chown -R node:node /app
USER node

ENV NODE_ENV=production SHOAL_TRUST_PROXY=1 PORT=4000
EXPOSE 4000
CMD ["node", "server/src/index.js"]
