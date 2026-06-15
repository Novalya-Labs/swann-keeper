# =============================================================================
# Swann — Home Assistant add-on image.
#
# Single container running ONLY the Node bot (dist/index.js) as one s6 longrun
# service "bot". Playback is @discordjs/voice + yt-dlp + ffmpeg (no Lavalink,
# no JVM) — much lighter on a Raspberry Pi.
#
# Base is the HA Alpine base (multi-arch incl. aarch64) which ships s6-overlay
# v3 + bashio. No CMD/ENTRYPOINT override: s6-overlay stays the init.
#
# Alpine = musl, so @discordjs/opus and sherpa-onnx-node have no matching glibc
# prebuilds and compile from source — hence the (virtual) build toolchain.
# =============================================================================
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23
FROM ${BUILD_FROM}

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

# --- Runtime packages ------------------------------------------------------
# nodejs / npm  : the bot runtime (Alpine 3.23 ships Node 22)
# yt-dlp        : YouTube/search resolution + audio stream URLs (community repo)
# ffmpeg        : prism-media transcode (48k stereo -> 16k mono) + playback
# libsodium / opus : voice deps (libsodium-wrappers is WASM, opus for @discordjs/opus)
RUN apk add --no-cache \
      nodejs \
      npm \
      yt-dlp \
      ffmpeg \
      libsodium \
      opus

WORKDIR /opt/app

# --- Install Node deps (native addons need a build toolchain on musl) -------
COPY package.json package-lock.json* ./
RUN apk add --no-cache --virtual .build-deps \
      python3 make g++ libtool autoconf automake libsodium-dev opus-dev \
 && (npm ci --omit=dev || npm install --omit=dev) \
 && apk del .build-deps

# --- Build the TypeScript -> dist/ -----------------------------------------
# Bring in tsconfig + sources and compile, then drop dev deps. tsc is a dev
# dependency, so install the full tree for the build then prune. npm run build
# also copies the admin assets into dist/.
COPY tsconfig.json ./
COPY src ./src
RUN apk add --no-cache --virtual .build-ts python3 make g++ \
 && npm install \
 && npm run build \
 && npm prune --omit=dev \
 && apk del .build-ts \
 && rm -rf ./src

# --- s6 service definitions + init scripts ---------------------------------
COPY rootfs /

# Health: nothing to expose besides the ingress port (handled by HA).
LABEL io.hass.version="0.2.0" \
      io.hass.type="addon" \
      io.hass.arch="aarch64|amd64"
