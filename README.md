# Swann — Discord Music Bot

Swann is a Discord music bot that:

- **Plays music** in a Discord voice channel via a self-hosted **Lavalink v4** node.
- **Understands natural language** in **text** ("Hey Swann, fais-moi une playlist de Jul de 10 sons") and **voice**, via **Mistral function-calling**.
- **Transcribes voice** with **Mistral Voxtral**.
- **Detects the "Swann" wake word** inside the Discord voice channel with **Picovoice Porcupine** + **Silero VAD** (sherpa-onnx).
- **Ships as a Home Assistant add-on** with an **Ingress** admin web UI.

Target hardware: **Raspberry Pi 5 (ARM64)** running Home Assistant OS. Also runs on a Pi 4 with reduced Lavalink heap.

---

## Architecture

```
                          ┌──────────────────────── Home Assistant add-on container ───────────────────────┐
                          │                                                                                 │
  Discord Gateway ◄──────►│  ┌─────────────┐   raw gw events   ┌──────────────┐                            │
                          │  │  discord    │ ────────────────► │   audio      │ ──REST/WS──► Lavalink (JVM) │
  Discord Voice  ◄──────► │  │ (client,    │ ◄──── snapshots ─ │ (lavalink-   │              :2333         │
                          │  │  slash cmds,│                   │  client)     │              (s6 service)  │
                          │  │  text trig) │                   └──────┬───────┘                            │
                          │  │             │                          │ AudioService                       │
                          │  │             │   VoiceCommandEvent      ▼                                     │
                          │  │             │ ◄──────────────── ┌──────────────┐  ToolExecutor              │
                          │  │             │                   │   mistral    │ ◄── tools ── (audio glue)   │
                          │  │  voice recv │ ──connection────► │  agent +     │                            │
                          │  │             │                   │  Voxtral     │                            │
                          │  └──────┬──────┘                   └──────────────┘                            │
                          │         │ PCM 16k mono                                                          │
                          │         ▼                                                                       │
                          │  ┌─────────────┐  wake "Swann"  ┌─────────┐  utterance  ┌──────────────┐       │
                          │  │   voice     │ ─────────────► │Porcupine│ ──────────► │ Silero VAD   │       │
                          │  │  pipeline   │                └─────────┘             │ (sherpa-onnx)│       │
                          │  └─────────────┘                                        └──────────────┘       │
                          │                                                                                 │
                          │  ┌─────────────┐  Ingress (X-Ingress-Path)                                      │
   HA panel  ◄────────────┼─►│   admin     │  live queue / history / cred status / controls               │
   (172.30.32.2)          │  │  (Fastify)  │  binds 0.0.0.0:8099                                            │
                          │  └─────────────┘                                                                │
                          └─────────────────────────────────────────────────────────────────────────────┘
```

### Module boundaries

All cross-module contracts live in **`src/types.ts`**. Modules never import each
other's implementation files — they depend only on the interfaces there, wired
together in `src/index.ts`. Key seams:

- `audio` exposes **`AudioService`** (Lavalink-backed, discord.js-agnostic).
- `mistral` exposes **`MistralAgent`** + **`Transcriber`**; it executes actions
  through an injected **`ToolExecutor`** so it never imports `audio` or `discord`.
- `voice` exposes **`VoiceListener`**, emits **`VoiceCommandEvent`**; `discord`
  owns the actual `VoiceConnection` and hands it to `voice.attach()`.
- `discord` is the composition root's main consumer: it builds `CommandContext`
  / `AgentContext` and drives `audio` + `mistral`.
- `admin` reads `AudioService` snapshots + `ConfigStatus` (no writes to secrets).
- `haos` is packaging only (no TypeScript surface).

---

## Tech stack (pinned)

| Concern            | Package / artifact                          | Version    |
|--------------------|---------------------------------------------|------------|
| Discord gateway    | `discord.js`                                | 14.26.4    |
| Voice send/receive | `@discordjs/voice`                          | 0.19.2     |
| Opus (native)      | `@discordjs/opus`                           | 0.10.0     |
| Media transcode    | `prism-media`                               | 1.3.5      |
| Encryption (WASM)  | `libsodium-wrappers`                        | 0.8.4      |
| Lavalink client    | `lavalink-client`                           | 2.10.2     |
| Lavalink node      | `ghcr.io/lavalink-devs/lavalink:4-alpine`   | 4.2.1      |
| YouTube source     | `dev.lavalink.youtube:youtube-plugin`       | 1.18.1     |
| Spotify metadata   | `com.github.topi314.lavasrc:lavasrc-plugin` | 4.8.3      |
| LLM / tools / STT  | `@mistralai/mistralai`                      | 2.2.1      |
| Wake word          | `@picovoice/porcupine-node`                 | 4.0.2      |
| VAD                | `sherpa-onnx-node`                          | 1.13.2     |
| Web admin          | `fastify` + `@fastify/static`               | 5.6.1 / 8.2.0 |
| Runtime            | Node.js (engines)                           | >= 22.12.0 |

> **Node 22+ is mandatory** — `@discordjs/voice` 0.19.x has `engines.node >= 22.12.0`.
>
> **Supply chain:** `@mistralai/mistralai` is pinned to **2.2.1**. Do **not** use
> 2.2.4 (confirmed compromised). Install with `npm ci` against the committed
> lockfile.

---

## 5-phase roadmap

1. **Phase 0 — Skeleton (this repo state).** Shared config, types, logger,
   tooling, dependency pinning, module placeholders. ✅
2. **Phase 1 — Audio + Discord core.** `audio` (Lavalink connect, player/queue)
   and `discord` (client, intents, `/play /skip /queue /stop`, "Hey Swann" text
   trigger, `src/index.ts` wiring). End state: text/slash commands play music.
3. **Phase 2 — Mistral agent.** Tool/function-calling agent (`search_songs`,
   `play_song`, `play_playlist`, queue control) + Voxtral transcription wrapper.
   End state: free-text NL requests drive the queue.
4. **Phase 3 — Voice in.** Discord voice **receive** pipeline: per-user
   Opus→16k mono PCM, Porcupine "Swann" wake word, Silero VAD utterance capture,
   transcribe → agent → execute. End state: spoken "Hey Swann …" works.
5. **Phase 4 — Packaging + admin.** Home Assistant add-on (`config.yaml`,
   Dockerfile, s6-overlay services for Lavalink + bot, `application.yml`) and the
   Ingress-aware admin web UI (live queue, history, credential status, controls).

---

## Configuration

In development, copy `.env.example` → `.env`. As a Home Assistant add-on the
Supervisor writes resolved options to `/data/options.json`; `src/config.ts`
prefers that over env automatically. Every credential is registered with the
logger so it is **never printed**.

Required to boot: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `MISTRAL_API_KEY`.

| Concern    | Env (dev)                                  | HA option (snake_case)               |
|------------|--------------------------------------------|--------------------------------------|
| Discord    | `DISCORD_TOKEN` `DISCORD_APP_ID` `DISCORD_GUILD_ID` | `discord_token` …            |
| Mistral    | `MISTRAL_API_KEY` `MISTRAL_CHAT_MODEL` …   | `mistral_api_key` …                  |
| Picovoice  | `PICOVOICE_ACCESS_KEY` `PICOVOICE_KEYWORD_PATH` … | `picovoice_access_key` …       |
| Lavalink   | `LAVALINK_HOST/PORT/PASSWORD/SECURE`       | `lavalink_host` …                    |
| Admin      | `INGRESS_PORT` `ADMIN_BIND_ADDRESS` `ADMIN_INGRESS_ONLY` | `ingress_port` …        |

---

## Development

```bash
npm ci                # install pinned deps (uses the lockfile)
npm run register      # register slash commands (guild-scoped if DISCORD_GUILD_ID set)
npm run dev           # run with ts-node + --watch
npm run build         # tsc -> dist/
npm start             # node dist/index.js
```

You need a reachable Lavalink v4 node for playback. Locally, run the official
image:

```bash
docker run --rm -p 2333:2333 \
  -e _JAVA_OPTIONS=-Xmx1G \
  -e LAVALINK_SERVER_PASSWORD=youshallnotpass \
  -v "$PWD/haos/lavalink/application.yml:/opt/Lavalink/application.yml" \
  ghcr.io/lavalink-devs/lavalink:4-alpine
```

---

## Raspberry Pi notes

- **64-bit OS required.** The ARM64 Lavalink image and the native Node addons
  (`@discordjs/opus`, `sherpa-onnx-node`, `@picovoice/porcupine-node`) target
  aarch64 — a 32-bit Pi OS will not work.
- **Lavalink JVM heap (`_JAVA_OPTIONS=-Xmx…`):**
  - **Pi 5 (8 GB):** `-Xmx2G` (up to `-Xmx4G` for many guilds/plugins).
  - **Pi 4 (4 GB):** `-Xmx1G`–`-Xmx1500M`; leave headroom for HA + the OS.
    Never leave `-Xmx` unset on a Pi 4 — the JVM may grab too much and get
    OOM-killed.
- **Native addons ship ARM64 prebuilds** (Porcupine, sherpa-onnx, and on a
  glibc base, `@discordjs/opus`). On the Alpine (musl) HA base, `@discordjs/opus`
  may compile from source — the Dockerfile adds `python3 make g++` for that.
- **System `ffmpeg`** is installed via the package manager in the image (more
  reliable on ARM64 than `ffmpeg-static`). Needed for non-Opus playback and for
  the 48k stereo → 16k mono resample feeding the wake-word/VAD/STT pipeline.
- **Picovoice keyword is platform-specific:** train the "Swann" `.ppn` for
  *Raspberry Pi* in the Picovoice Console; a Windows/Web `.ppn` will not load.
- **First Lavalink boot is slow** (downloads plugin JARs, JIT warm-up);
  subsequent boots are fast. Mount a writable `plugins/` volume.

---

## Security

- Secrets live only in `.env` (dev) or the HA add-on protected options
  (`/data/options.json`) — never baked into the image or committed.
- The admin UI relies on Home Assistant for auth (Ingress). It implements no
  login and, in production, rejects anything not from the HA gateway
  `172.30.32.2`.
- `@mistralai/mistralai` is pinned to a known-good version; install via `npm ci`.

---

## License

Private / internal (Novalya).
