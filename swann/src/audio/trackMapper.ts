/**
 * Swann — audio/trackMapper.
 *
 * Normalises yt-dlp's `-J` JSON output (single video entries and playlist /
 * flat-playlist entries) into the shared, library-agnostic domain types from
 * `src/types.ts`. Keeping this conversion in one place means the rest of the
 * codebase never touches a raw yt-dlp structure directly.
 *
 * yt-dlp emits two relevant shapes:
 *   - a *video* object: `{ id, title, uploader, duration, webpage_url, ... }`
 *   - a *playlist* object: `{ _type: 'playlist', title, entries: [...] }`
 * With `--flat-playlist` the search entries are lighter (`{ id, title,
 * channel, duration, url }`). We read every field defensively so an upstream
 * format change or a missing field never crashes playback.
 */

import type { QueueItem, SearchResult, Track } from '../types.js';

/** Minimal structural view of a single yt-dlp JSON entry we rely on. */
export interface YtdlpEntry {
  id?: unknown;
  _type?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  uploader_id?: unknown;
  duration?: unknown;
  webpage_url?: unknown;
  url?: unknown;
  original_url?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
  extractor?: unknown;
  extractor_key?: unknown;
  ie_key?: unknown;
  is_live?: unknown;
  live_status?: unknown;
  entries?: unknown;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Pick the best thumbnail: explicit `thumbnail`, else last of `thumbnails`. */
function pickThumbnail(entry: YtdlpEntry): string | undefined {
  const direct = optStr(entry.thumbnail);
  if (direct) return direct;
  if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
    // yt-dlp orders thumbnails worst -> best, so the last is the largest.
    const last = entry.thumbnails[entry.thumbnails.length - 1] as { url?: unknown } | undefined;
    return optStr(last?.url);
  }
  return undefined;
}

/** Resolve a canonical, yt-dlp-playable watch URL for an entry. */
function resolveUri(entry: YtdlpEntry): string {
  const explicit = optStr(entry.webpage_url) ?? optStr(entry.original_url) ?? optStr(entry.url);
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
  const id = optStr(entry.id);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return explicit ?? '';
}

/**
 * Convert a single yt-dlp JSON entry into the shared `Track` shape.
 *
 * `duration` is in seconds (yt-dlp); we convert to ms. A null/0 duration is
 * treated as a live stream (durationMs 0, isStream true) per the contract.
 */
export function mapTrack(entry: YtdlpEntry): Track {
  const durationSec = num(entry.duration, 0);
  const live =
    entry.is_live === true ||
    str(entry.live_status) === 'is_live' ||
    durationSec <= 0;
  const durationMs = live ? 0 : Math.trunc(durationSec * 1000);

  const track: Track = {
    uri: resolveUri(entry),
    encoded: str(entry.id),
    title: str(entry.title, 'Unknown title'),
    author: str(entry.uploader ?? entry.channel ?? entry.uploader_id, 'Unknown artist'),
    durationMs,
    isStream: live,
  };

  const artworkUrl = pickThumbnail(entry);
  const sourceName =
    optStr(entry.extractor) ??
    optStr(entry.extractor_key) ??
    optStr(entry.ie_key) ??
    'youtube';

  return {
    ...track,
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
    sourceName,
  };
}

/** Map a list of yt-dlp entries, skipping null/unresolvable holes. */
export function mapTracks(entries: ReadonlyArray<YtdlpEntry | null | undefined>): Track[] {
  const out: Track[] = [];
  for (const e of entries) {
    if (e && typeof e === 'object') out.push(mapTrack(e));
  }
  return out;
}

/**
 * Wrap a domain `Track` into a `QueueItem` with requester metadata. Used when
 * enqueuing tracks resolved outside of `play()` (e.g. agent playlists).
 */
export function toQueueItem(
  track: Track,
  requestedBy: string,
  requestedByName: string,
  addedAt: number = Date.now(),
): QueueItem {
  return { track, requestedBy, requestedByName, addedAt };
}

/**
 * Convert a parsed yt-dlp `-J` document into the shared `SearchResult`.
 *
 * @param doc       The parsed JSON (a playlist object, a single video object,
 *                  or — for `--flat-playlist` searches — a playlist of light
 *                  entries).
 * @param isSearch  True when the query was a `ytsearch:` search (so a multi-
 *                  entry result is "search" candidates rather than a "playlist").
 */
export function mapYtdlpResult(doc: unknown, isSearch: boolean): SearchResult {
  if (doc === null || typeof doc !== 'object') {
    return { kind: 'empty', tracks: [] };
  }
  const entry = doc as YtdlpEntry;

  // Playlist / search-result document (has an `entries` array).
  if (Array.isArray(entry.entries)) {
    const tracks = mapTracks(entry.entries as YtdlpEntry[]);
    if (tracks.length === 0) return { kind: 'empty', tracks: [] };
    if (isSearch) return { kind: 'search', tracks };
    const playlistName = optStr(entry.title);
    return playlistName !== undefined
      ? { kind: 'playlist', tracks, playlistName }
      : { kind: 'playlist', tracks };
  }

  // Single video document.
  const track = mapTrack(entry);
  if (!track.uri) return { kind: 'empty', tracks: [] };
  return { kind: 'track', tracks: [track] };
}
