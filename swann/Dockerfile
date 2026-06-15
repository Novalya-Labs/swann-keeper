# =============================================================================
# Swann — Home Assistant add-on image.
#
# Single container running ONLY the Node bot (dist/index.js) as one s6 longrun
# service "bot". Playback is @discordjs/voice + yt-dlp + ffmpeg (no Lavalink,
# no JVM) — much lighter on a Raspberry Pi.
#
# Base is the HA *Debian* (glibc) base, NOT Alpine. The native addons
# (@discordjs/opus, sherpa-onnx-node, @picovoice/porcupine-node) only ship
# prebuilt binaries for glibc — on Alpine/musl @discordjs/opus has no prebuild
# and its from-source build fails on ARM64 (libopus NEON bug). On glibc they
# all download prebuilds, so no C/C++ toolchain is needed at all.
#
# Node is pinned to 22 (NodeSource): @discordjs/opus 0.10.0 publishes prebuilds
# only up to node-v127 (Node 22). Node 24 (node-v137) has NO prebuild and would
# force the failing source compile.
#
# Base is Debian *bullseye* (glibc 2.31), NOT bookworm. @discordjs/node-pre-gyp
# matches the glibc version EXACTLY in the prebuild filename: opus 0.10.0 ships
# arm64 prebuilds for glibc-2.31 and glibc-2.35 only. Bookworm is glibc-2.36 ->
# no asset -> falls back to the failing source compile. Bullseye = 2.31 -> exact
# match -> the prebuild downloads, no compile.
# =============================================================================
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:bullseye
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# --- Runtime packages ------------------------------------------------------
# nodejs 22  : the bot runtime + the ABI the opus prebuild targets (node-v127)
# ffmpeg     : prism-media transcode (48k stereo -> 16k mono) + playback
# yt-dlp     : self-contained static binary (bundles Python) for the target arch
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils ffmpeg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && case "$(uname -m)" in \
      aarch64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
      x86_64)  YTDLP_ASSET=yt-dlp_linux ;; \
      *) echo "Unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

# --- Install Node deps (native addons resolve to glibc prebuilds, no compile) -
# Full install (incl. dev) so tsc is available for the build below.
COPY package.json package-lock.json* ./
RUN npm ci

# --- Build the TypeScript -> dist/, then drop dev deps ----------------------
# `npm run build` also copies the admin assets into dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf ./src

# --- s6 service definitions + init scripts ---------------------------------
COPY rootfs /

# Health: nothing to expose besides the ingress port (handled by HA).
LABEL io.hass.version="0.2.2" \
      io.hass.type="addon" \
      io.hass.arch="aarch64|amd64"
