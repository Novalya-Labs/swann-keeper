# Changelog

## 0.4.1

Make voice receive resilient to corrupt Opus packets (the reason no audio
reached the wake engine).

- The receive pipeline previously piped the whole Opus stream through one
  streaming decoder; a single corrupt packet ("The compressed data passed is
  corrupted" — e.g. a DAVE E2EE transition frame) threw and tore down the entire
  pipeline, so zero frames ever reached the KWS engine. Now each packet is
  decoded individually and a bad one is skipped, not fatal.
- With `kws_debug` on, each pipeline logs `Receive pipeline stats {packets,
  decodeFailures, framesOut}` — so we can see whether audio is actually decoding
  (framesOut > 0) or every packet is corrupt (decodeFailures == packets).

## 0.4.0

Add a wake-word diagnostic mode to tune detection.

- New `kws_debug` option. When enabled, the wake engine runs a parallel ASR
  over the same audio and logs, at INFO: a periodic audio-level heartbeat
  (`KWS DEBUG audio {frames, peak}`) and the raw transcript of each utterance
  (`KWS DEBUG heard {transcript}`). This confirms audio is reaching the engine
  and shows exactly how the model decodes a given pronunciation, so the
  `keywords.txt` tokens can be matched to it. Leave it off in normal use.

## 0.3.3

Fix the admin web UI showing `{"ok":false,"error":"Internal error"}`.

- HA Ingress can request the panel root with a doubled slash (`//`), which
  resolved to the `@fastify/static` root **directory** — the static plugin
  rejects that with 403, which the error handler turned into a 500. The server
  now collapses repeated slashes in the request path before routing, so `//`
  maps to the `/` SPA-shell route. (Reproduced and verified.)

## 0.3.2

Fix a startup crash: `RangeError: Maximum call stack size exceeded`.

- The admin wiring formed an infinite loop: `index.ts` passed
  `pushActivity = (e) => recordActivity(e)` **and** then set
  `recordActivity = admin.recordActivity`, while the admin server's
  `recordActivity` calls `pushActivity` back — so each activity entry recursed
  forever. Removed the `pushActivity` argument; all activity now flows once
  through `admin.recordActivity` into the store.

## 0.3.1

Fix the container dying instantly with `s6-overlay-suexec: fatal: can only run
as pid 1`.

- Set **`init: false`** in the add-on manifest. The base image ships its own
  s6-overlay v3, which must be PID 1; without this the Supervisor inserts tini
  as PID 1 and s6 refuses to start. (Only surfaced now that the image finally
  builds and runs.)

## 0.3.0

Replace Picovoice/Porcupine with an on-device, open-source wake word.

- Wake-word detection now uses **sherpa-onnx KeywordSpotter** (the same ONNX
  runtime already used for the Silero VAD) — fully local, no account, no API
  key, no online activation. Removes the `@picovoice/porcupine-node` dependency.
- New options replace the `picovoice_*` ones: `kws_encoder_path`,
  `kws_decoder_path`, `kws_joiner_path`, `kws_tokens_path`, `kws_keywords_path`,
  `kws_threshold`, `kws_score`. Model files live under `/config/kws/` (see DOCS).
- Model-file paths now default under **`/config`** (the `addon_config` mount)
  instead of `/data`, matching where you drop files via Samba/File editor.
- Text control is unchanged and still needs none of the above.

## 0.2.2

Use the Debian **bullseye** base (glibc 2.31) so the opus prebuild matches.

- `@discordjs/node-pre-gyp` matches the glibc version **exactly** in the prebuild
  filename. `@discordjs/opus` 0.10.0 ships arm64 prebuilds for `glibc-2.31` and
  `glibc-2.35` only. Bookworm (0.2.1) is glibc-2.36 → no asset → it fell back to
  the failing source compile. Bullseye is glibc-2.31 → exact match → the prebuild
  downloads, no compilation.

## 0.2.1

Fix the add-on image build on Raspberry Pi (ARM64).

- Switched the base image from Alpine (musl) to the HA **Debian/glibc** base.
  The native addons (`@discordjs/opus`, `sherpa-onnx-node`,
  `@picovoice/porcupine-node`) only ship **glibc** prebuilds; on Alpine
  `@discordjs/opus` has no prebuild and its from-source build fails on ARM64
  (libopus NEON `celt_inner_prod_neon` error).
- Pinned **Node 22** (NodeSource): `@discordjs/opus` 0.10.0 publishes prebuilds
  only up to `node-v127` (Node 22). Alpine 3.23 shipped Node 24 (`node-v137`),
  which has no prebuild and forced the failing compile.
- `yt-dlp` is now the self-contained static binary for the target arch; `ffmpeg`
  comes from apt. No C/C++ toolchain in the image anymore (all prebuilds).

## 0.2.0

Dropped Lavalink/Java; playback is now fully in-process.

- Removed the embedded Lavalink v4 node, the JVM (`openjdk17-jre-headless`),
  and all `lavalink_*` / `spotify_*` options.
- Playback now uses **@discordjs/voice** with **yt-dlp** (search + audio stream
  resolution) and **ffmpeg** (transcode), both baked into the image. No Java —
  much lighter on a Raspberry Pi.
- Single-container packaging supervised by s6-overlay v3 with one self-
  restarting `bot` service (the `lavalink` service was removed).
- New options: `ytdlp_path`, `ytdlp_format`, `ytdlp_cookies_path`,
  `search_limit_max`. Drop an optional `cookies.txt` into the add-on config dir
  for yt-dlp.

## 0.1.0

Initial release.

- Embedded Lavalink v4 (4.2.1) with the `youtube-source` (1.18.1) plugin and
  optional LavaSrc (4.8.3) Spotify support.
- Node bot: slash commands (`/play`, `/skip`, `/queue`, `/stop`), text and voice
  natural-language control (Mistral function-calling + Voxtral), and the "Swann"
  wake word (Picovoice Porcupine + Silero VAD).
- Ingress admin web UI on port 8099.
- Single-container packaging supervised by s6-overlay v3 (separate, self-
  restarting `lavalink` and `bot` services), on `aarch64` and `amd64`.
