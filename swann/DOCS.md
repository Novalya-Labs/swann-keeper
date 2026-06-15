# Swann

A Discord music bot for Home Assistant. It plays audio with **@discordjs/voice**
(streaming from **yt-dlp** and transcoding with **ffmpeg**), understands
**natural-language requests** in text and voice (Mistral function-calling +
Voxtral transcription), wakes on the **"Swann"** keyword (Picovoice Porcupine +
Silero VAD), and exposes an **Ingress admin web UI** — all inside one add-on
container.

There is no Java or Lavalink: playback runs entirely in the Node process using
yt-dlp and ffmpeg, which keeps the add-on much lighter on a Raspberry Pi. The
bot runs as a single, self-restarting service under s6-overlay; you do not
manage it individually.

## Requirements

- A 64-bit Home Assistant OS install on `aarch64` (e.g. Raspberry Pi 5) or
  `amd64`.
- A Discord application + bot (token and application ID).
- A Mistral AI API key.
- A Picovoice access key and a trained **"Swann"** wake-word file, plus the
  Silero VAD model (only required if you want **voice** control; text control
  works without them).

## Installation

1. In Home Assistant go to **Settings → Add-ons → Add-on Store**, open the
   three-dot menu, choose **Repositories**, and add this repository's URL.
2. Find **Swann** in the store and click **Install**. First build is slow on a
   Pi (it compiles native modules); later starts are fast.
3. Open the **Configuration** tab and fill in the options (see below).
4. Start the add-on, then open it from the sidebar (the admin UI) to verify
   status.

## Model and cookie files

Place the following in the add-on's `/config` directory (it appears at `/data/`
inside the container, which is why the defaults point there):

- The trained `.ppn` **"Swann"** keyword file (built for the **Raspberry Pi**
  platform in the Picovoice Console) — required for voice.
- `silero_vad.onnx` (from the sherpa-onnx releases) — required for voice.
- Optionally, a Netscape-format `cookies.txt` for yt-dlp, to bypass age/region
  gates or YouTube rate-limits. Point `ytdlp_cookies_path` at it (e.g.
  `/data/cookies.txt`).

## Configuration

All options map 1:1 to the bot's internal config. Secrets are stored only in the
add-on's protected configuration and never logged.

### Discord

| Option | Required | Notes |
| --- | --- | --- |
| `discord_token` | yes | Bot token (Developer Portal → Bot). |
| `discord_app_id` | yes | Application (client) ID for slash-command registration. |
| `discord_guild_id` | no | A server ID for instant guild-scoped commands. Empty = global (up to ~1h to propagate). |

Enable the **Server Members** intent only if your bot needs it; Swann's slash
commands do not require the privileged Message Content intent. The text wake
phrase trigger does require Message Content — enable it in the Developer Portal
if you use `text_wake_phrase`.

### Mistral

| Option | Required | Default |
| --- | --- | --- |
| `mistral_api_key` | yes | — |
| `mistral_chat_model` | no | `mistral-medium-3-5` |
| `mistral_transcribe_model` | no | `voxtral-mini-latest` |

### Picovoice (voice / wake word)

| Option | Required for voice | Default |
| --- | --- | --- |
| `picovoice_access_key` | yes | — |
| `picovoice_keyword_path` | yes | `/data/Swann_en_raspberry-pi_v3_0_0.ppn` |
| `picovoice_sensitivity` | no | `0.6` |
| `silero_vad_path` | yes | `/data/silero_vad.onnx` |

### Playback (yt-dlp / ffmpeg)

Playback is built into the bot — `yt-dlp` and `ffmpeg` ship inside the add-on
image, so the defaults are correct for almost everyone:

| Option | Default | Notes |
| --- | --- | --- |
| `ytdlp_path` | `yt-dlp` | Path/name of the yt-dlp binary on PATH. |
| `ytdlp_format` | `bestaudio[ext=webm]/bestaudio/best` | yt-dlp `-f` audio format selector. |
| `ytdlp_cookies_path` | empty | Optional `cookies.txt` (e.g. `/data/cookies.txt`) to bypass gates/rate-limits. |
| `search_limit_max` | `25` | Max results a single search/playlist resolves (1..50). |

### Admin UI & behaviour

| Option | Default | Notes |
| --- | --- | --- |
| `ingress_port` | `8099` | Keep at 8099 for Ingress. |
| `admin_bind_address` | `0.0.0.0` | Keep for Ingress. |
| `admin_ingress_only` | `true` | Only the HA Ingress gateway may reach the UI. |
| `log_level` | `info` | `trace` / `debug` / `info` / `warning` / `error`. |
| `text_wake_phrase` | `Hey Swann` | Chat trigger for the agent. |
| `default_volume` | `80` | 0..100. |

## Usage

- **Slash commands:** `/play`, `/skip`, `/queue`, `/stop`.
- **Text agent:** type, e.g. `Hey Swann play some lo-fi` in any channel the bot
  can read.
- **Voice agent:** join a voice channel, say **"Swann"**, then your request
  (e.g. *"Swann, play the next song"*).
- **Admin UI:** open the add-on from the HA sidebar to see live now-playing,
  queue, history, credential status, and basic controls.

## How it runs (for the curious)

The container is supervised by **s6-overlay v3** with a single longrun service:

- `bot` — starts the Node bot (`node /opt/app/dist/index.js`). It resolves and
  streams audio with `yt-dlp` and transcodes with `ffmpeg`, both baked into the
  image, then ships PCM to Discord via `@discordjs/voice`.

The service restarts on its own if it crashes, without taking the container
down. The web UI is served behind Home Assistant Ingress, so it inherits HA's
authentication — Swann adds no login of its own.

## Troubleshooting

- **Add-on won't build:** ensure your HA is on a recent Supervisor and the host
  is 64-bit. The build compiles native modules; a low-RAM device can be slow.
- **No voice detection:** confirm the `.ppn` and `silero_vad.onnx` files exist
  at the configured paths and the `.ppn` was trained for the Raspberry Pi /
  Linux platform.
- **YouTube errors ("sign in to confirm…"):** YouTube may rate-limit the host
  IP. Supplying a `cookies.txt` (`ytdlp_cookies_path`) or updating the add-on
  (which refreshes the bundled `yt-dlp`) usually resolves it.
- **Admin UI links broken:** always open the UI via the HA sidebar/Ingress, not
  by hitting the port directly.
- **Check logs:** the add-on **Log** tab shows the bot output. Raise
  `log_level` to `debug` for more detail.
