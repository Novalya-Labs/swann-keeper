# Changelog

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
