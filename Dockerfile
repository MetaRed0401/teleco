# syntax=docker/dockerfile:1.7

ARG NODE_MAJOR=22
ARG PNPM_VERSION=11.5.3
ARG CODEX_CLI_VERSION

FROM ubuntu:24.04 AS base

ARG NODE_MAJOR
ARG PNPM_VERSION
ARG CODEX_CLI_VERSION

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:/usr/local/bin:/usr/bin:/bin

COPY codex-versions.json /tmp/codex-versions.json

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gnupg \
      make \
      g++ \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      sqlite3 \
      tini \
      xz-utils \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && resolved_codex_cli_version="${CODEX_CLI_VERSION:-$(node -p "require('/tmp/codex-versions.json').recommended")}" \
    && npm install -g "@openai/codex@${resolved_codex_cli_version}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY codex-versions.json ./codex-versions.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build \
    && pnpm prune --prod

FROM base AS runtime

ENV NODE_ENV=production \
    HOME=/home/telecodex \
    TELECODEX_WORKSPACE=/workspace

RUN useradd --create-home --home-dir /home/telecodex --uid 1001 --shell /bin/bash telecodex \
    && install -d -o telecodex -g telecodex /app /workspace /home/telecodex/.codex

WORKDIR /app

COPY --from=build --chown=telecodex:telecodex /app/package.json ./package.json
COPY --from=build --chown=telecodex:telecodex /app/codex-versions.json ./codex-versions.json
COPY --from=build --chown=telecodex:telecodex /app/node_modules ./node_modules
COPY --from=build --chown=telecodex:telecodex /app/dist ./dist

USER telecodex

RUN codex --version >/dev/null \
    && codex app-server --help >/dev/null

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
