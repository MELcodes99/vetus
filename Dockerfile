FROM node:22-slim

# kpass (Kite Agent Passport CLI) needs curl and jq to install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/root
ENV PATH="/root/.local/bin:/root/.kpass/bin:${PATH}"

# Install kpass. The installer may try to install agent skills interactively; with no terminal
# that step is skipped, and only the CLI matters here. The build fails if kpass is missing.
RUN curl -fsSL https://agentpassport.ai/install.sh -o /tmp/install.sh \
 && (bash /tmp/install.sh < /dev/null || true) \
 && kpass --version

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# kpass reads its login from /app/.kite-passport, written at start from KPASS_CONFIG_B64.
ENV NODE_ENV=production KPASS_DIR=/app
EXPOSE 4402
CMD ["node", "src/server.js"]
