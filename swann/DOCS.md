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
- For **voice** control only (text works without any of this): a sherpa-onnx
  **keyword-spotting (KWS)** model, a tokenized **"Swann"** keywords file, and
  the Silero VAD model. All run on-device — no account, no API key, no online
  activation (this replaces the old Picovoice/Porcupine dependency).

## Installation

1. In Home Assistant go to **Settings → Add-ons → Add-on Store**, open the
   three-dot menu, choose **Repositories**, and add this repository's URL.
2. Find **Swann** in the store and click **Install**. First build is slow on a
   Pi (it compiles native modules); later starts are fast.
3. Open the **Configuration** tab and fill in the options (see below).
4. Start the add-on, then open it from the sidebar (the admin UI) to verify
   status.

## Model and cookie files

Place files in the add-on's config directory. With the `addon_config` mapping
that folder is `/addon_configs/swann/` on the host (reachable via the **Samba**
or **File editor** add-on) and is mounted at **`/config`** inside the container —
which is why the defaults point at `/config`.

For **voice** (all optional; skip entirely for text-only use):

1. **Silero VAD** — download `silero_vad.onnx` from the sherpa-onnx releases and
   place it at `/config/silero_vad.onnx`.
2. **Wake-word KWS model** — download an English streaming KWS model, e.g.
   `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`
   (<https://github.com/k2-fsa/sherpa-onnx/releases>). Extract it and place the
   files under `/config/kws/`, renaming the three ONNX files so they match the
   defaults:
   - `encoder.onnx`, `decoder.onnx`, `joiner.onnx`
   - `tokens.txt`
3. **Keywords file** — `/config/kws/keywords.txt` must contain the **"Swann"**
   keyword **encoded as model tokens** (not plain text). Generate it once with
   the model's BPE tokenizer using sherpa-onnx's `text2token`:

   ```bash
   # from a checkout of sherpa-onnx, using the model's bpe.model:
   python3 ./scripts/text2token.py \
     --tokens /config/kws/tokens.txt \
     --tokens-type bpe \
     --bpe-model /path/to/bpe.model \
     --input  - --output /config/kws/keywords.txt <<< "SWANN @swann"
   ```

   The resulting line looks like `▁S W ANN :swann` (exact tokens depend on the
   model). Lower `kws_threshold` (e.g. `0.15`) or raise `kws_score` if "Swann"
   is missed; raise the threshold if it false-fires.

Optionally, a Netscape-format `cookies.txt` for yt-dlp (to bypass age/region
gates or YouTube rate-limits): place it at `/config/cookies.txt` and point
`ytdlp_cookies_path` at it.

For **spoken replies (TTS)** — optional, off by default — install a French
Piper voice into `/config/tts/`:

1. Download `vits-piper-fr_FR-siwis-medium.tar.bz2` from the sherpa-onnx TTS
   releases (<https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models>).
2. Extract it into `/config/tts/` so you have:
   - `/config/tts/fr_FR-siwis-medium.onnx`
   - `/config/tts/tokens.txt`
   - `/config/tts/espeak-ng-data/` (directory)
3. Set `tts_enabled: true` and restart. Swann then speaks its answers aloud
   (pausing/resuming the music). If the files are missing it just stays silent.

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

### Wake word (sherpa-onnx KWS) / VAD — voice only

On-device keyword spotting; no account or API key. All paths default under
`/config` (see "Model and cookie files").

| Option | Required for voice | Default |
| --- | --- | --- |
| `kws_encoder_path` | yes | `/config/kws/encoder.onnx` |
| `kws_decoder_path` | yes | `/config/kws/decoder.onnx` |
| `kws_joiner_path` | yes | `/config/kws/joiner.onnx` |
| `kws_tokens_path` | yes | `/config/kws/tokens.txt` |
| `kws_keywords_path` | yes | `/config/kws/keywords.txt` |
| `kws_threshold` | no | `0.25` (lower = more sensitive) |
| `kws_score` | no | `1.0` (per-keyword boost) |
| `silero_vad_path` | yes | `/config/silero_vad.onnx` |

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
  is 64-bit. The image pulls native prebuilds (no compilation).
- **No voice detection:** confirm the KWS model files (`encoder.onnx`,
  `decoder.onnx`, `joiner.onnx`, `tokens.txt`), the tokenized `keywords.txt`, and
  `silero_vad.onnx` all exist at the configured `/config` paths. The admin UI's
  "Wake-word model (KWS)" / "Silero VAD model" rows show presence. If "Swann" is
  missed, lower `kws_threshold` (e.g. `0.15`); if it false-fires, raise it.
- **YouTube errors ("sign in to confirm…"):** YouTube may rate-limit the host
  IP. Supplying a `cookies.txt` (`ytdlp_cookies_path`) or updating the add-on
  (which refreshes the bundled `yt-dlp`) usually resolves it.
- **Admin UI links broken:** always open the UI via the HA sidebar/Ingress, not
  by hitting the port directly.
- **Check logs:** the add-on **Log** tab shows the bot output. Raise
  `log_level` to `debug` for more detail.
