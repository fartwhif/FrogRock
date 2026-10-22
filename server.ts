// server.ts
// Broadcast-mode FrogRock server with per-client ICY manifold:
// - Each client gets its own icy.Writer for metadata injection
// - Per-client queue with configurable size limit
// - Slow clients dropped when queue overflows or lag exceeds threshold
// - Global IMMUTABLE state (updates create new objects/Sets)
// - Single live audio source → all clients hear the same content
// - Real-time pacing (~128 kbps)

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import CodecParser, { CodecFrame, MPEGHeader } from 'codec-parser';
import { Writer } from './src/icy-writer';

const execFileAsync = promisify(execFile);

/** Use ffprobe as ground truth for audio properties (MP3 header can lie about downmixed audio). */
async function probeAudioProps(filePath: string): Promise<{ bitrate: number; channels: number; sampleRate: number }> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=bit_rate',
      '-show_entries', 'stream=channels',
      '-show_entries', 'stream=sample_rate',
      '-of', 'default=noprint_wrappers=1',
      filePath
    ]);
    const parse = (key: string): number => {
      const m = stdout.match(new RegExp(`${key}=(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };
    return {
      bitrate: parse('bit_rate'),
      channels: parse('channels') || 2,
      sampleRate: parse('sample_rate'),
    };
  } catch {
    return { bitrate: 0, channels: 2, sampleRate: 0 };
  }
}

// Whitelist of known ICY/Shoutcast-compatible players.
// Only these clients receive ICY metadata blocks. All other clients
// (browsers, unknown agents) get plain audio with no metadata injection.
// This is safer than a browser blacklist — browsers have infinite UA variants
// and any miss causes audible glitches from metadata bytes in the audio stream.
const ICY_CAPABLE_CLIENTS = [
  // Desktop players
  'VLC',
  'Winamp',
  'WMPlayer',           // Windows Media Player
  'Foobar2000',
  'MusicBee',
  'MPC-HC',
  'MPC-BE',
  'KMPlayer',
  'PotPlayer',
  'iTunes',
  'Music',              // macOS Music app
  'Audacious',
  'Rhythmbox',
  'Clementine',
  'Quod Libet',
  'LXMusic',
  'Decibel',
  'Ampache',
  'Songbird',
  // Mobile players
  'nPlayer',
  'FX',                 // FX File Explorer built-in player
  'Neutron',            // Neutron Music Player
  'PowerAmp',
  'VLC for Android',
  'VLC for iOS',
  'Doppler',
  // Network/streaming clients
  'Shoutcast',
  'Icecast',
  'Kodi',
  'Plex',
  'Jellyfin',
  'Subsonic',
  'Navidrome',
  'Airsonic',
  'Squeezelite',
  'Logitech Media Server',
  'LMS',
  // Other known good
  'ffplay',
  'ffmpeg',
  'GStreamer',
  'mpv',
  'mpv.com',
  'mplayer',
  'wmplayer',
  'WACUP',
];

function isIcyCapableClient(ua: string | undefined): boolean {
  if (!ua) return false;
  const upper = ua.toUpperCase();
  return ICY_CAPABLE_CLIENTS.some(client => upper.includes(client.toUpperCase()));
}

// ====================== EXHAUSTIVE TYPES (from index.json.example) ======================
interface Channel {
  id: string;
  channelId: string;
  title: string;
  order: number;
  ignoreScrapeDone: boolean;
  createdAt: string;
}

interface Track {
  id: string;
  videoId: string;
  channelId: string;
  title: string;
  description: string | null;
  publishedAt: string;
  thumbnailPath: string;
  audioPath: string;
  subtitlePath: string | null;
  watched: boolean;
  progress: number;
  duration: number;
  ignored: boolean;
  createdAt: string;
  channel: Channel;
  author: string;
  source?: 'main';
  isGrabby?: boolean;
}

interface AppState {
  playlist: readonly Track[];
  currentTrackIndex: number;
  completedTracks: ReadonlySet<string>;
  grabbyPlayed: ReadonlyMap<string, string>;
  currentTrackStartTime: number;
}

type StatePartial = Partial<{
  playlist: Track[];
  currentTrackIndex: number;
  completedTracks: Set<string>;
  grabbyPlayed: Map<string, string>;
  currentTrackStartTime: number;
}>;

// ====================== CONSTANTS ======================
const PORT = parseInt(process.env.PORT || '8090', 10);
const CACHE_DIR = process.env.CACHE_DIR || 'UNCONFIGURED';
const INDEX_JSON_PATH = path.join(CACHE_DIR, 'index.json');
const COMPLETED_TRACKS_PATH = path.join(CACHE_DIR, 'completed.json');
const GRABBY_PLAYED_PATH = path.join(CACHE_DIR, 'grabby-played.json');
const STATUS_PATH = path.join(CACHE_DIR, 'status.json');
const METAIMNT_TARGET = 16000;
const MAX_METADATA_LEN = 255;

// Per-client queue settings (Icecast-style backpressure)
const CLIENT_QUEUE_MAX_BYTES = parseInt(process.env.CLIENT_QUEUE_MAX_BYTES || '65536', 10);
const CLIENT_LAG_MAX_MS = parseInt(process.env.CLIENT_LAG_MAX_MS || '10000', 10);

// Burst buffer for new-client prebuffering (duration in seconds, resized per track)
const BURST_DURATION_SEC = parseInt(process.env.BURST_DURATION_SEC || '8', 10);

// Silence prefix (seconds) in the current track's own format, prepended to the head
// of every track. Absorbs the DNAS-relay reconnect gap at a podcast vs grabby format
// flip (5-6 s) so the new track's first seconds are not 'eaten'. Set 0 to disable.
const SILENCE_PREFIX_SEC = Math.max(0, parseInt(process.env.SILENCE_PREFIX_SEC || '8', 10));

// ====================== SHOUTCAST DIRECTORY ======================
// The Shoutcast directory (directory.shoutcast.com) lists our station. We poll
// the directory's own search endpoint + tunein playlist (the same endpoints the
// directory web UI calls) and probe the registered stream URL — the same check
// Shoutcast's reachability monitor performs — to determine whether the listing
// is UP. The web UI card is shown only while that is true.
const SHOUTCAST_QUERY = process.env.SHOUTCAST_QUERY || 'FrogRock';
const SHOUTCAST_STATION_NAME = process.env.SHOUTCAST_STATION_NAME || 'FrogRock Radio';
const SHOUTCAST_SEARCH_URL = `http://directory.shoutcast.com/Search?query=${encodeURIComponent(SHOUTCAST_QUERY)}`;
const SHOUTCAST_POLL_MS = parseInt(process.env.SHOUTCAST_POLL_MS || '60000', 10);
const SHOUTCAST_HTTP_TIMEOUT_MS = 15000;

// ====================== STARTUP CHECKS ======================
if (CACHE_DIR === 'UNCONFIGURED') {
  console.error('ERROR: CACHE_DIR environment variable is not set.');
  process.exit(1);
}

// ====================== GLOBAL IMMUTABLE STATE ======================
let state: AppState = Object.freeze({
  playlist: Object.freeze([] as Track[]),
  currentTrackIndex: 0,
  completedTracks: Object.freeze(new Set<string>()),
  grabbyPlayed: Object.freeze(new Map<string, string>()),
  currentTrackStartTime: Date.now(),
});

function updateState(partial: StatePartial): void {
  const newPlaylist = partial.playlist
    ? Object.freeze([...partial.playlist])
    : state.playlist;

  const newCompleted = partial.completedTracks
    ? Object.freeze(new Set(partial.completedTracks))
    : state.completedTracks;

  const newGrabbyPlayed = partial.grabbyPlayed
    ? Object.freeze(new Map(partial.grabbyPlayed))
    : state.grabbyPlayed;

  const newState: AppState = {
    ...state,
    ...partial,
    playlist: newPlaylist,
    completedTracks: newCompleted,
    grabbyPlayed: newGrabbyPlayed,
  };

  state = Object.freeze(newState);
}

// ====================== BURST BUFFER (frame-aligned backlog) ======================
class BurstBuffer {
  private frames: Buffer[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(frame: Buffer): void {
    this.frames.push(frame);
    while (this.frames.length > this.capacity) {
      this.frames.shift();
    }
  }

  peek(): Buffer {
    if (this.frames.length === 0) return Buffer.alloc(0);
    return Buffer.concat(this.frames);
  }

  getAvailable(): number {
    return this.frames.length;
  }
}

// ====================== PER-CLIENT CONNECTION ======================
class ClientConnection {
  public res: http.ServerResponse;
  public writer: Writer | null;
  private queueBytes: number = 0;
  private lastDataTime: number = Date.now();
  private disconnected: boolean = false;

  constructor(res: http.ServerResponse, useIcy: boolean) {
    this.res = res;

    if (useIcy) {
      this.writer = new Writer(currentMetaint, {
        highWaterMark: 32768,
      });

      this.writer.on('drain', () => {
        this.queueBytes = 0;
      });

      this.writer.on('error', (err: Error) => {
        if (!this.disconnected) {
          console.log(`Client writer error: ${err.message}`);
          this.disconnect('Writer error');
        }
      });

      this.writer.pipe(res, { end: false });
    } else {
      this.writer = null;
    }
  }

  formatMetadata(title: string, artist: string, channel: string): string {
    const raw = `${artist} - ${title}`;
    return raw.length > MAX_METADATA_LEN ? raw.slice(0, MAX_METADATA_LEN) : raw;
  }

  queueMetadata(_title: string, _artist: string, _channel: string): void {
    if (this.disconnected || !this.writer) return;
    try {
      const metaStr = this.formatMetadata(_title, _artist, _channel);
      this.writer.queue({ StreamTitle: ` ${metaStr};` });
    } catch (err) {
      console.error('Metadata queue error:', err);
    }
  }

  writeAudio(chunk: Buffer): boolean {
    if (this.disconnected) return false;
    this.lastDataTime = Date.now();

    if (this.writer) {
      const ok = this.writer.write(chunk);
      if (!ok) {
        this.queueBytes += chunk.length;
      }
      if (this.queueBytes > CLIENT_QUEUE_MAX_BYTES) {
        this.disconnect('Client queue overflow (fell too far behind)');
        return false;
      }
      return true;
    }

    return this.res.write(chunk);
  }

  burstFromBuffer(buffer: BurstBuffer): void {
    if (this.disconnected) return;
    const data = buffer.peek();
    if (data.length > 0) {
      if (this.writer) {
        this.writer.write(data);
      } else {
        this.res.write(data);
      }
    }
  }

  getLagMs(sourceStartTime: number): number {
    const elapsed = Date.now() - sourceStartTime;
    return elapsed;
  }

  isBehind(elapsedMs: number): boolean {
    return elapsedMs > CLIENT_LAG_MAX_MS && this.queueBytes > CLIENT_QUEUE_MAX_BYTES / 2;
  }

disconnect(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    console.log(`  \u2715 Dropped client: ${reason}`);
    try {
      if (this.writer) {
        this.writer.destroy();
      }
      this.res.end();
    } catch {
      // already closed
    }
  }

  isAlive(): boolean {
    return !this.disconnected && this.res.writable && !this.res.writableEnded;
  }
}

// ====================== CLIENT MANIFOLD ======================
class ClientManifold {
  private _clients: ClientConnection[] = [];

  get clients(): ClientConnection[] {
    return this._clients;
  }

  add(client: ClientConnection): void {
    this._clients.push(client);
  }

  remove(client: ClientConnection): void {
    const idx = this._clients.indexOf(client);
    if (idx !== -1) {
      this._clients.splice(idx, 1);
    }
  }

  get size(): number {
    return this._clients.length;
  }

  broadcastAudio(chunk: Buffer, trackTitle: string, trackAuthor: string, trackChannel: string, sourceStartTime: number): void {
    audioBuffer.push(chunk);

    if (this._clients.length === 0) return;

    const toRemove: ClientConnection[] = [];

    for (const client of this._clients) {
      if (!client.isAlive()) {
        toRemove.push(client);
        continue;
      }

      const elapsed = Date.now() - sourceStartTime;

      if (client.isBehind(elapsed)) {
        toRemove.push(client);
        client.disconnect('Client fell too far behind');
        continue;
      }

      client.writeAudio(chunk);
    }

    for (const client of toRemove) {
      this.remove(client);
    }
  }

  broadcastMetadata(title: string, artist: string, channel: string): void {
    for (const client of this._clients) {
      if (client.isAlive()) {
        client.queueMetadata(title, artist, channel);
      }
    }
  }

  getActiveCount(): number {
    return this._clients.filter(c => c.isAlive()).length;
  }

  prune(): number {
    const before = this._clients.length;
    this._clients = this._clients.filter(c => c.isAlive());
    const removed = before - this._clients.length;
    if (removed > 0) {
      console.log(`Pruned ${removed} dead client(s) (remaining: ${this._clients.length})`);
    }
    return removed;
  }
}

const manifold = new ClientManifold();
let audioBuffer = new BurstBuffer(0);
// ====================== TARGET-FORMAT TRANSCODE CACHE ======================
// Keep the public audio format stable across all tracks (podcast audio is
// natively 64 kbps / mono / 24 kHz; grabby tracks arrive in arbitrary
// formats, e.g. 160 k/44.1 k/stereo). Non-conforming tracks are transcoded
// on demand to the target spec via ffmpeg (libmp3lame) and cached as a
// sidecar file next to the original (`.tr64k.mp3`), then retrieved from
// cache on later plays. The original file is never modified.
const TRANSCODE_BITRATE = 64000;    // bps
const TRANSCODE_CHANNELS = 1;      // mono
const TRANSCODE_SAMPLE_RATE = 24000;

/**
 * One target-format silence frame. 24 kHz is an MPEG2-only rate → 576
 * samples/frame → 72·64000/24000 = 192 bytes/frame (identical to the native
 * podcast frame). Header bytes ff f3 84 c4 verified against a real
 * 64 k/24 k/mono LAME encode and against live podcast files (frameSize 192).
 * Payload is all zeros → decodes to exact digital silence.
 */
const TARGET_FRAME: Buffer = (() => {
  const f = Buffer.alloc(192);
  f[0] = 0xff; f[1] = 0xf3; f[2] = 0x84; f[3] = 0xc4;
  return f;
})();
const TARGET_METAINT = Math.max(1, Math.round(METAIMNT_TARGET / TARGET_FRAME.length)) * TARGET_FRAME.length;

/** ffprobe-based check that a file already streams as the target format. */
async function isTargetFormat(filePath: string): Promise<boolean> {
  try {
    const { bitrate, channels, sampleRate } = await probeAudioProps(filePath);
    return bitrate === TRANSCODE_BITRATE &&
      channels === TRANSCODE_CHANNELS &&
      sampleRate === TRANSCODE_SAMPLE_RATE;
  } catch {
    return false;
  }
}

class TranscodeSuperseded extends Error {
  constructor() { super('transcode superseded mid-run'); this.name = 'TranscodeSuperseded'; }
}

/**
 * Encode input → outputPath at the target spec (libmp3lame, no Xing/ID3 so
 * the frame parser reads from offset 0). While ffmpeg runs, target-format
 * silence is pumped to the manifold every 200 ms so the public stream holds
 * at a constant 64 kbps / 24 kHz / mono and never presents another codec
 * format mid-transition. If the track is superseded mid-run (live skip or a
 * newer track starting), the ffmpeg child is killed and the pump stopped;
 * the partial sidecar is left for the next start to revalidate (the original
 * is never touched either way).
 */
async function transcodeToTarget(
  inputPath: string,
  outputPath: string,
  metaTitle: string,
  author: string,
  channel: string,
  trackStart: number,
  isCurrent: () => boolean,
): Promise<void> {
  const ffmpeg = spawn('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vn',
    '-ac', String(TRANSCODE_CHANNELS),
    '-ar', String(TRANSCODE_SAMPLE_RATE),
    '-b:a', '64k',
    // No Xing/Info/ID3 headers: codec-parser must parse frames from offset 0.
    '-write_xing', '0', '-id3v2_version', '0',
    outputPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const pumpSilence = (ms: number): void => {
    if (!isCurrent()) return;
    const frames = Math.max(1, Math.ceil((ms / 1000) * (TRANSCODE_SAMPLE_RATE / 576)));
    const buf = Buffer.alloc(frames * TARGET_FRAME.length);
    for (let i = 0; i < frames; i++) TARGET_FRAME.copy(buf, i * TARGET_FRAME.length);
    manifold.broadcastAudio(buf, metaTitle, author, channel, trackStart);
    manifold.prune();
  };
  const pumpTimer = setInterval(() => pumpSilence(200), 200);

  // On the first tick after the track is superseded (live skip / new start),
  // kill the transcode child immediately rather than letting it run to
  // completion — the station no longer needs this file.
  const supersedeWatch = setInterval(() => {
    if (isCurrent()) return;
    try { ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
  }, 100);

  let stderrBuf = '';
  ffmpeg.stderr!.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    ffmpeg.on('error', (err: Error) => {
      console.warn('ffmpeg spawn error:', err.message);
      resolve({ code: null });
    });
    ffmpeg.on('close', (c: number | null) => resolve({ code: c }));
  });
  clearInterval(pumpTimer);
  clearInterval(supersedeWatch);
  clearInterval(pumpTimer);

  // Superseded mid-run: kill the child (if still alive) and stop here. The
  // pump is already silenced (isCurrent() false); we abandon this transcode.
  if (!isCurrent()) {
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
      try { ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
    }
    throw new TranscodeSuperseded();
  }

  pumpSilence(200);
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}: ${stderrBuf.slice(-400)}`);
  }
}

/**
 * Resolve a streamable path for the track. If the original already streams
 * at the target format, return it directly (fast path). Otherwise return the
 * sidecar cache if fresh and valid. Otherwise signal that a transcode must
 * run — the caller owns the ordering of metaint push + silence stream, then
 * invokes the returned `run()` and revalidates the result.
 */
async function resolveOrTranscodeSpec(
  originalPath: string,
): Promise<
  | { kind: 'direct'; path: string }
  | { kind: 'cached'; path: string }
  | { kind: 'transcode'; run: (metaTitle: string, author: string, channel: string,
      trackStart: number, isCurrent: () => boolean) => Promise<string> }
> {
  if (await isTargetFormat(originalPath)) return { kind: 'direct', path: originalPath };

  const sidecarPath = `${originalPath}.tr64k.mp3`;
  try {
    const [orig, side] = await Promise.all([
      fs.promises.stat(originalPath),
      fs.promises.stat(sidecarPath),
    ]);
    if (side.mtimeMs >= orig.mtimeMs && (await isTargetFormat(sidecarPath))) {
      return { kind: 'cached', path: sidecarPath };
    }
  } catch {
    // no cache yet
  }

  // Transcode directly into a real .mp3-named sidecar (ffmpeg infers the
  // encoder from the extension). On any failure — real ffmpeg error or a
  // supersede mid-run — remove the partial file so it can never be mistaken
  // for a valid cache hit; the original is never touched either way.
  const run = async (
    metaTitle: string,
    author: string,
    channel: string,
    trackStart: number,
    isCurrent: () => boolean,
  ): Promise<string> => {
    try {
      await transcodeToTarget(originalPath, sidecarPath, metaTitle, author, channel, trackStart, isCurrent);
    } catch (err) {
      try { fs.unlinkSync(sidecarPath); } catch { /* not present */ }
      throw err;
    }
    return sidecarPath;
  };
  return { kind: 'transcode', run };
}

// ====================== ACTIVE STREAM STATE ======================
let isPlaying = false;
let currentTrackData: Track | null = null;
let currentByteOffset = 0;
let trackStartTime = Date.now();
let currentTrackBitrate = 0;
let currentTrackChannels = 0;
let currentTrackSampleRate = 0;
let currentTrackFileSize = 0;
let currentFrameSize = 417;
let currentMetaint = METAIMNT_TARGET;

// ====================== PATH NORMALIZATION ======================
// Upstream index.json may use absolute paths (/cache/...) or relative paths.
// Normalize to relative (relative to CACHE_DIR) for consistent resolution.
function normalizePath(p: string): string {
  if (p.startsWith('/cache/')) {
    return p.slice(7); // strip /cache/ prefix
  }
  return p;
}

// ====================== PLAYLIST MANAGEMENT ======================
/** publishedAt as epoch ms; malformed/missing values sort to the bottom. */
function publishedTime(t: Track): number {
  const ms = new Date(t.publishedAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function refreshPlaylist(): void {
  if (!fs.existsSync(INDEX_JSON_PATH)) {
    console.error(`index file not found: ${INDEX_JSON_PATH}`);
    return;
  }

  // Load the index once; we need it both to build the playlist and to know
  // which IDs are grabby. Grabby tracks are music content (intended for
  // indefinite rotation — see DrivePod's distributeGrabbyItems), so they
  // are EXCLUDED from the completed set: adding them would cause
  // advanceToNextTrack to permanently skip them until the full reset.
  let index: Track[] = [];
  try {
    const indexData = fs.readFileSync(INDEX_JSON_PATH, 'utf8');
    const parsed = JSON.parse(indexData);
    if (Array.isArray(parsed)) {
      index = parsed
        .filter((item): item is Track => Boolean(item && item.audioPath))
        .map((t: Track) => ({
          ...t,
          source: 'main' as const,
          audioPath: normalizePath(t.audioPath),
          thumbnailPath: normalizePath(t.thumbnailPath),
        }));
    }
    // Re-sort newest-first on every refresh (DrivePod "newest" strategy).
    // publishedAt desc, videoId asc tiebreak — the same deterministic
    // ordering DrivePod uses to generate index.json, so batched imports and
    // grabby cluster bands (shared timestamps) stay stable across refreshes.
    index.sort((a, b) => {
      const d = publishedTime(b) - publishedTime(a);
      return d !== 0 ? d : a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
    });
  } catch (error) {
    console.error('Error reading index file:', error);
    return;
  }

  const grabbyIds = new Set(index.filter(t => t.isGrabby === true).map(t => t.id));

  // Rebuild the completed set from disk, dropping any grabby ids that may
  // have been persisted by the old code (they must stay playable).
  const newCompleted = new Set<string>();
  if (fs.existsSync(COMPLETED_TRACKS_PATH)) {
    try {
      const completedData = fs.readFileSync(COMPLETED_TRACKS_PATH, 'utf8');
      const parsed = JSON.parse(completedData);
      if (Array.isArray(parsed)) {
        for (const id of parsed as string[]) {
          if (!grabbyIds.has(id)) newCompleted.add(id);
        }
      }
    } catch (e) {
      console.error('Error loading completed tracks:', e);
    }
  }
  for (const id of state.completedTracks) {
    if (!grabbyIds.has(id)) newCompleted.add(id);
  }

  // Rebuild the recently-played grabby set from disk + memory. An entry
  // survives only while the index still carries that item with the same
  // publishedAt: DrivePod's distributeGrabbyItems reconditions a grabby
  // item with a fresh clustered timestamp, which is the re-entrance signal
  // (its equivalent of the watched-flag reset) — items that vanished from
  // the index are dropped.
  const pubById = new Map<string, string>();
  for (const t of index) pubById.set(t.id, t.publishedAt);
  const newGrabbyPlayed = new Map<string, string>();
  if (fs.existsSync(GRABBY_PLAYED_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(GRABBY_PLAYED_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [id, playedAt] of Object.entries(parsed as Record<string, string>)) {
          if (typeof playedAt === 'string' && pubById.get(id) === playedAt) newGrabbyPlayed.set(id, playedAt);
        }
      }
    } catch (e) {
      console.error('Error loading grabby-played tracks:', e);
    }
  }
  for (const [id, playedAt] of state.grabbyPlayed) {
    if (pubById.get(id) === playedAt) newGrabbyPlayed.set(id, playedAt);
  }

  // Preserve current track index — find current track by ID in new playlist
  let newIndex = state.currentTrackIndex;
  const playingId = currentTrackData?.id;
  if (playingId) {
    const found = index.findIndex(t => t.id === playingId);
    if (found !== -1) {
      newIndex = found;
    }
  }

  updateState({
    playlist: index,
    currentTrackIndex: newIndex,
    completedTracks: newCompleted,
    grabbyPlayed: newGrabbyPlayed,
  });

  const grabbyCount = grabbyIds.size;
  console.log(`Playlist refreshed — ${index.length} tracks (${grabbyCount} grabby; ${newCompleted.size} completed; ${newGrabbyPlayed.size} grabby recently played)`);
}

function saveCompletedTracks(): void {
  try {
    fs.writeFileSync(
      COMPLETED_TRACKS_PATH,
      JSON.stringify(Array.from(state.completedTracks), null, 2)
    );
  } catch (error) {
    console.error('Error saving completed tracks:', error);
  }
}

function saveGrabbyPlayed(): void {
  try {
    const tmpPath = GRABBY_PLAYED_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(state.grabbyPlayed), null, 2));
    fs.renameSync(tmpPath, GRABBY_PLAYED_PATH);
  } catch (error) {
    console.error('Error saving grabby-played tracks:', error);
  }
}

/** Record that a finished track has aired: podcasts join the persisted
 *  completed set; grabby items join the recently-played set — they stay
 *  replayable (DrivePod reconditions them for indefinite rotation) but must
 *  not be re-picked immediately by the newest-first selection. */
function markTrackPlayed(track: Track): void {
  if (track.isGrabby !== true) {
    const newCompleted = new Set(state.completedTracks);
    newCompleted.add(track.id);
    updateState({ completedTracks: newCompleted });
    saveCompletedTracks();
  } else {
    const newPlayed = new Map(state.grabbyPlayed);
    newPlayed.set(track.id, track.publishedAt);
    updateState({ grabbyPlayed: newPlayed });
    saveGrabbyPlayed();
  }
}

// ====================== FRAME PROBING ======================
function probeFirstFrames(filePath: string, startOffset: number): {
  bitrate: number;
  channels: number;
  sampleRate: number;
  frameSize: number;
  frames: CodecFrame[];
} {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4096);
  const read = fs.readSync(fd, buf, 0, 4096, startOffset);
  fs.closeSync(fd);

  const parser = new CodecParser('audio/mpeg', { enableFrameCRC32: false });
  const frames = [...parser.parseChunk(buf.slice(0, read)) as unknown as Generator<CodecFrame>];

  if (frames.length === 0) {
    console.error(`FATAL: No parseable MP3 frames in ${filePath}`);
    process.exit(1);
  }

  const header = frames[0].header as MPEGHeader;
  const bitrate = header.bitrate * 1000;
  const channels = header.channelMode === 'mono' ? 1 : header.channelMode === 'single_channel' ? 1 : 2;
  const sampleRate = header.sampleRate;
  const frameSize = Math.max(...frames.slice(0, 5).map(f => f.data.length));

  return { bitrate, channels, sampleRate, frameSize, frames };
}

function buildSilencePrefix(templateFrame: CodecFrame, seconds: number): Buffer {
  if (seconds <= 0 || !templateFrame || templateFrame.data.length < 4) return Buffer.alloc(0);
  const h = templateFrame.header as MPEGHeader;
  const frameSize = templateFrame.data.length;
  // MP3: MPEG v1/v1.5 = 1152 samples/frame, v2/v2.5 = 576 samples/frame.
  // mpegVersion is a string ('1' or '2') per codec-parser types.
  const samplesPerFrame = h.sampleRate > 16000 ? 1152 : 576;
  const numFrames = Math.ceil((seconds * h.sampleRate) / samplesPerFrame);
  const out = Buffer.alloc(numFrames * frameSize);
  const hdr = Buffer.from(templateFrame.data.buffer, templateFrame.data.byteOffset, 4);
  for (let i = 0; i < numFrames; i++) {
    hdr.copy(out, i * frameSize);
  }
  return out;
}

function computeBurstCapacity(frameSize: number, bitrate: number): number {
  const maxMetadataSize = 1 + 16 * 255;
  const contentAwareFrames = Math.ceil((METAIMNT_TARGET + maxMetadataSize) / frameSize) + 2;
  const timeBasedFrames = Math.ceil((bitrate / 8 * BURST_DURATION_SEC) / frameSize);
  return Math.max(contentAwareFrames, timeBasedFrames);
}

// ====================== STATUS PERSISTENCE ======================
function writeStatus(): void {
  const status = isPlaying ? 'playing' : 'idle';
  const elapsedMs = Date.now() - trackStartTime;
  const statusObj = {
    status,
    currentTrack: currentTrackData,
    currentTrackIndex: state.currentTrackIndex,
    completedTracks: Array.from(state.completedTracks),
    grabbyPlayed: Object.fromEntries(state.grabbyPlayed),
    bitrate: currentTrackBitrate,
    channels: currentTrackChannels,
    sampleRate: currentTrackSampleRate,
    byteOffset: currentByteOffset,
    fileSize: currentTrackFileSize,
    percentage: currentTrackFileSize > 0 ? Math.round((currentByteOffset / currentTrackFileSize) * 10000) / 100 : 0,
    elapsedSec: Math.round(elapsedMs / 1000 * 1000) / 1000,
    trackElapsedMs: elapsedMs,
    listeners: manifold.getActiveCount(),
    timestamp: new Date().toISOString(),
  };
  try {
    const tmpPath = STATUS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(statusObj, null, 2));
    fs.renameSync(tmpPath, STATUS_PATH);
  } catch (error) {
    console.error('Error writing status:', error);
  }
}

// ====================== BROADCAST STREAMING ======================
async function startCurrentTrack(): Promise<void> {
  if (isPlaying) {
    isPlaying = false;
  }

  const trackIndex = state.currentTrackIndex;
  const track = state.playlist[trackIndex];

  if (!track || !track.audioPath) {
    console.error('No valid track at index', trackIndex);
    setTimeout(advanceToNextTrack, 1000);
    return;
  }

  const filePath = path.join(CACHE_DIR, track.audioPath);
  if (!fs.existsSync(filePath)) {
    console.error(`Audio file not found: ${filePath}`);
    advanceToNextTrack();
    return;
  }

  // Claim this track first: any in-flight start/transcode/loop for another
  // track sees currentTrackData change and abandons its output (live skip).
  currentTrackData = track;

  // Decide what goes on the wire: the original (already target format), a
  // cached sidecar, or a transcode that runs now. The transcode path holds
  // the wire with target-format silence so the public stream never flips
  // into another codec format mid-transition.
  const spec = await resolveOrTranscodeSpec(filePath);
  if (currentTrackData?.id !== track.id) {
    console.log(`  ~ superseded during prep for ${track.title || path.basename(filePath)}`);
    return;
  }

  let streamPath: string;
  if (spec.kind === 'transcode') {
    const channel = track.channel?.title ?? 'Unknown';
    const title = track.title || path.basename(filePath);
    const isCurrent = (): boolean => currentTrackData?.id === track.id;

    // Set the target metaint on every client writer BEFORE any audio (the
    // silence pump) reaches the wire, then stream silence while transcode.
    currentMetaint = TARGET_METAINT;
    for (const client of manifold.clients) {
      if (client.writer) client.writer.metaint = TARGET_METAINT;
    }
    manifold.broadcastMetadata(title, track.author, channel);

    let sidecarPath: string | undefined;
    try {
      sidecarPath = await spec.run(title, track.author, channel, trackStartTime, isCurrent);
    } catch (err) {
      if (!isCurrent()) return;
      console.warn(`⚠ transcode failed — falling back to original: ${(err as Error).message}`);
    }
    if (!isCurrent()) return;

    if (sidecarPath !== undefined && (await isTargetFormat(sidecarPath))) {
      streamPath = sidecarPath;
    } else {
      streamPath = filePath;
      if (sidecarPath !== undefined) console.warn(`  ~ sidecar invalid, streaming original`);
    }
  } else {
    streamPath = spec.path;
  }

  await streamResolvedTrack(streamPath, filePath, track);
}

/**
 * Stream an already-resolved audio file in real time: probe, metaint, burst
 * buffer, silence prefix, first frames, and the pacing loop with
 * superseded-detection so a live skip abandons the stale stream promptly.
 */
async function streamResolvedTrack(streamPath: string, originalPath: string, track: Track): Promise<void> {
  let startOffset = 0;
  try {
    const fd = fs.openSync(streamPath, 'r');
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);
    fs.closeSync(fd);
    if (header.toString('ascii', 0, 3) === 'ID3') {
      const size = (header[6] & 0x7f) * 16777216 + (header[7] & 0x7f) * 65536 + (header[8] & 0x7f) * 256 + (header[9] & 0x7f);
      startOffset = 10 + size;
    }
  } catch {
    startOffset = 0;
  }

  const trackStart = Date.now();
  trackStartTime = trackStart;
  currentByteOffset = 0;
  const trackFileSize = fs.statSync(streamPath).size;
  currentTrackFileSize = trackFileSize;

  // Ground truth for UI display (bitrate, channels, sampleRate)
  const { bitrate, channels, sampleRate } = await probeAudioProps(streamPath);
  currentTrackBitrate = bitrate;
  currentTrackChannels = channels;
  currentTrackSampleRate = sampleRate;

  // codec-parser only for frameSize (internal stream pacing)
  const { frameSize, frames: probeFrames } = probeFirstFrames(streamPath, startOffset);
  currentFrameSize = frameSize;

  // Calculate metaint as a multiple of frame size to avoid splitting MP3 frames
  const framesPerMeta = Math.round(METAIMNT_TARGET / frameSize);
  const trackMetaint = framesPerMeta * frameSize;
  currentMetaint = trackMetaint;

  if (currentTrackData?.id !== track.id) {
    console.log(`  ~ superseded before stream start for ${track.title || path.basename(streamPath)}`);
    return;
  }

  // Push new metaint to existing ICY writers so metadata stays frame-aligned
  for (const client of manifold.clients) {
    if (client.writer) {
      client.writer.metaint = trackMetaint;
    }
  }

  const burstCapacityFrames = computeBurstCapacity(frameSize, bitrate);
  audioBuffer = new BurstBuffer(burstCapacityFrames);

  const metaTitle = track.title || path.basename(streamPath);
  const channelInfo = track.channel?.title ? ` [${track.channel.title}]` : '';
  const sourceNote = streamPath === originalPath ? '' : ' (target-format transcode)';
  console.log(`▶️  Broadcasting: ${metaTitle}${channelInfo}${sourceNote} (startOffset: ${startOffset}, bitrate: ${bitrate / 1000}kbps, frameSize: ${frameSize}, metaint: ${trackMetaint} (${framesPerMeta} frames), burst: ${burstCapacityFrames} frames)`);

  manifold.broadcastMetadata(
    metaTitle,
    track.author,
    track.channel?.title ?? 'Unknown'
  );

  // Silence prefix in the track's own (now uniformly target) format: holds
  // the wire during the DNAS relay's 5–6 s reconnect window at a track flip
  // so the re-attached handshake replays silence, never the track's head.
  if (SILENCE_PREFIX_SEC > 0) {
    const silence = buildSilencePrefix(probeFrames[0], SILENCE_PREFIX_SEC);
    if (silence.length > 0) {
      manifold.broadcastAudio(
        silence,
        metaTitle,
        track.author,
        track.channel?.title ?? 'Unknown',
        trackStart
      );
      manifold.prune();
    }
  }

  for (const frame of probeFrames) {
    manifold.broadcastAudio(
      Buffer.from(frame.data),
      metaTitle,
      track.author,
      track.channel?.title ?? 'Unknown',
      trackStart
    );
  }

  isPlaying = true;
  const t = Date.now();
  let sent = startOffset + probeFrames.reduce((sum, f) => sum + f.data.length, 0);
  const fd = fs.openSync(streamPath, 'r');
  const audioBytes = trackFileSize - startOffset;
  const contentLengthSec = audioBytes / (bitrate / 8);
  const parser = new CodecParser('audio/mpeg', { enableFrameCRC32: false });

  const pump = (maxBytes: number, flush: boolean): void => {
    const readSize = Math.min(Math.ceil(maxBytes), trackFileSize - sent);
    const buf = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, sent);
    if (bytesRead <= 0) return;
    sent += bytesRead;
    currentByteOffset = sent;
    const frames = [...parser.parseChunk(buf.slice(0, bytesRead)) as unknown as Generator<CodecFrame>];
    for (const frame of frames) {
      manifold.broadcastAudio(
        Buffer.from(frame.data),
        metaTitle,
        track.author,
        track.channel?.title ?? 'Unknown',
        trackStart
      );
    }
    if (flush) {
      for (const frame of parser.flush() as unknown as Generator<CodecFrame>) {
        manifold.broadcastAudio(
          Buffer.from(frame.data),
          metaTitle,
          track.author,
          track.channel?.title ?? 'Unknown',
          trackStart
        );
      }
    }
    manifold.prune();
  };

  const closeFd = (): void => {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };

  const streamLoop = async () => {
    try {
      while (sent < trackFileSize && currentTrackData?.id === track.id) {
        const g = (Date.now() - t) / 1000;
        const shouldHaveSent = (g / contentLengthSec) * audioBytes + startOffset;
        const behind = shouldHaveSent - sent;
        if (behind > 0) {
          pump(Math.min(Math.ceil(behind), 8192), false);
        }
        await new Promise(r => setTimeout(r, 100));
      }
      if (currentTrackData?.id !== track.id) {
        // Superseded mid-play (live skip / new start): the newer track owns
        // the stream now — do not flush/advance from this stale loop.
        closeFd();
        return;
      }
      pump(8192, true);
      closeFd();
      console.log(`✓ Finished: ${track.title || path.basename(streamPath)}`);

      markTrackPlayed(track);

      advanceToNextTrack();
    } catch (err) {
      closeFd();
      console.error('Stream error:', (err as Error).message);
      if (currentTrackData?.id === track.id) {
        advanceToNextTrack();
      }
    }
  };

  streamLoop();
}

function advanceToNextTrack(): void {
  // DrivePod "newest" autoplay strategy: the next track is the most recently
  // published unplayed item. The queue is sorted publishedAt desc on every
  // refresh, so that is the first entry that is either a not-yet-aired
  // grabby item (never completed; excluded only until DrivePod reconditions
  // it with a fresh clustered publishedAt) or a podcast that has not been
  // completed.
  const pickNext = (): number =>
    state.playlist.findIndex(t =>
      t.isGrabby === true ? !state.grabbyPlayed.has(t.id) : !state.completedTracks.has(t.id));

  let nextIndex = pickNext();
  if (nextIndex === -1 && state.playlist.length > 0) {
    // Full rotation: nothing unplayed remains (every podcast completed,
    // every grabby item recently aired and not yet reconditioned) — clear
    // both played sets and restart from the newest track.
    console.log('All tracks completed — resetting playlist');
    updateState({ completedTracks: new Set<string>(), grabbyPlayed: new Map<string, string>() });
    saveCompletedTracks();
    saveGrabbyPlayed();
    nextIndex = pickNext();
  }

  updateState({
    currentTrackIndex: nextIndex === -1 ? 0 : nextIndex,
    currentTrackStartTime: Date.now(),
  });

  startCurrentTrack().catch((err: Error) => {
    console.error('startCurrentTrack error:', err.message);
  });
}

// ====================== MIME TYPES ======================
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function serveStaticFile(res: http.ServerResponse, filePath: string, contentType?: string): boolean {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = contentType || MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(data);
  return true;
}

function serveThumb(res: http.ServerResponse, relPath: string): void {
  const filePath = path.join(CACHE_DIR, relPath);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'image/webp';
  const data = fs.readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(data);
}

// ====================== SHOUTCAST LISTING STATUS (server-poll cache) ======================
interface ShoutcastStatus {
  up: boolean;
  streamUrl: string;
  searchUrl: string;
  stationName: string;
  checkedAt: string;
}

let shoutcastStatus: ShoutcastStatus = {
  up: false,
  streamUrl: '',
  searchUrl: SHOUTCAST_SEARCH_URL,
  stationName: SHOUTCAST_STATION_NAME,
  checkedAt: '',
};

interface ShoutcastSearchStation {
  ID: number;
  Name: string;
  StreamUrl?: string | null;
  [key: string]: unknown;
}

/** Directory web-UI search endpoint (POST, form-encoded) — the same call directory.shoutcast.com/Search makes. */
async function shoutcastSearchStations(): Promise<ShoutcastSearchStation[]> {
  const res = await fetch('https://directory.shoutcast.com/Search/UpdateSearch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `query=${encodeURIComponent(SHOUTCAST_QUERY)}`,
    signal: AbortSignal.timeout(SHOUTCAST_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return (await res.json()) as ShoutcastSearchStation[];
}

/** Directory tunein playlist (what players get) — yields the shoutcast stream URL. */
async function shoutcastTuneinUrl(stationId: number): Promise<string> {
  const res = await fetch(`http://yp.shoutcast.com/sbin/tunein-station.pls?id=${stationId}`, {
    signal: AbortSignal.timeout(SHOUTCAST_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tunein HTTP ${res.status}`);
  const m = (await res.text()).match(/^File1=(.+)$/m);
  return m ? m[1].trim() : '';
}

/** Directory web-player stream URL (fallback for the tunein playlist). Response is a JSON-encoded string. */
async function shoutcastPlayerStreamUrl(stationId: number): Promise<string> {
  const res = await fetch('https://directory.shoutcast.com/Player/GetStreamUrl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: `station=${stationId}`,
    signal: AbortSignal.timeout(SHOUTCAST_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GetStreamUrl HTTP ${res.status}`);
  const text = (await res.text()).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return text;
  }
}

/**
 * Playability probe: does the shoutcast-registered stream URL serve live audio?
 *
 * Mirrors the directory's own reachability check — YP's tester, Winamp, and the
 * Shoutcast mobile app all connect to the stored URL directly. Our listing
 * stores a raw-IP http:// URL (a raw-IP URL can never present a valid
 * certificate), so plain HTTP is the listener path: gthost :8000 is dual-mode
 * (plain + TLS, SHOUTCAST.md point 12) and the directory's web player plays
 * the domain form via http→https auto-upgrade. https URLs are still checked
 * for a valid TLS chain, exactly as a browser would.
 */
async function shoutcastStreamIsLive(url: string): Promise<boolean> {
  if (!/^https?:/i.test(url)) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok || !res.body) return false;
    const ctype = res.headers.get('content-type') || '';
    if (!/audio|mpeg|octet-stream/i.test(ctype)) return false;
    // A single TCP read can be tiny; accumulate real audio bytes before deciding.
    const reader = res.body.getReader();
    let received = 0;
    const deadline = Date.now() + 8000;
    while (received < 4096 && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value?.byteLength ?? 0;
    }
    await res.body.cancel().catch(() => {});
    return received >= 4096;
  } catch {
    return false;
  }
}

/** One poll cycle: search the directory, resolve the stream URL, probe it. */
async function pollShoutcast(): Promise<void> {
  const result: ShoutcastStatus = {
    up: false,
    streamUrl: '',
    searchUrl: SHOUTCAST_SEARCH_URL,
    stationName: SHOUTCAST_STATION_NAME,
    checkedAt: new Date().toISOString(),
  };
  try {
    const stations = await shoutcastSearchStations();
    const station = stations.find(
      (s) => typeof s?.Name === 'string' && s.Name.toLowerCase() === SHOUTCAST_STATION_NAME.toLowerCase()
    );
    if (!station) {
      console.log(`[shoutcast] "${SHOUTCAST_STATION_NAME}" not found in directory search results`);
    } else {
      result.stationName = station.Name;
      let streamUrl = '';
      try {
        streamUrl = await shoutcastTuneinUrl(station.ID);
      } catch { /* fall through to web-player URL */ }
      if (!streamUrl) {
        try {
          streamUrl = await shoutcastPlayerStreamUrl(station.ID);
        } catch { /* leave empty */ }
      }
      result.streamUrl = streamUrl;
      if (streamUrl && (await shoutcastStreamIsLive(streamUrl))) {
        result.up = true;
      }
      console.log(`[shoutcast] listed="${station.Name}" streamUrl="${streamUrl}" up=${result.up}`);
    }
  } catch (err) {
    console.error(`[shoutcast] poll failed: ${(err as Error).message}`);
  }
  shoutcastStatus = result;
}

// ====================== HTTP SERVER ======================
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = req.url || '/';
  const [pathPart, queryString] = url.split('?');
  const params = new URLSearchParams(queryString || '');

  // Stream endpoint
  if (pathPart === '/stream.mp3' || pathPart === '/stream') {
    const ua = req.headers['user-agent'] || 'unknown';
    const useIcy = isIcyCapableClient(ua);

    console.log(`New client connected (active: ${manifold.getActiveCount() + 1}) [UA: ${ua}] ${useIcy ? '→ ICY enabled' : '→ plain audio (no metadata)'}`);

    res.writeHead(200, useIcy ? {
      'Content-Type': 'audio/mpeg',
      'icy-name': 'FrogRock Radio',
      'icy-description': 'DrivePod Radio Stream (Live)',
      'icy-genre': 'Podcast',
      'icy-pub': '1',
      'icy-br': String(currentTrackBitrate ? Math.round(currentTrackBitrate / 1000) : 128),
      'icy-metaint': String(currentMetaint),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Pragma': 'no-cache',
      'Expires': '0',
    } : {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    const client = new ClientConnection(res, useIcy);
    manifold.add(client);

    if (currentTrackData) {
      client.queueMetadata(
        currentTrackData.title || path.basename(currentTrackData.audioPath),
        currentTrackData.author,
        currentTrackData.channel?.title ?? 'Unknown'
      );
    }

    if (isPlaying) {
      client.burstFromBuffer(audioBuffer);
    }

    const cleanup = () => {
      manifold.remove(client);
      console.log(`Client disconnected (remaining: ${manifold.getActiveCount()})`);
    };

    res.on('close', cleanup);

    if (!isPlaying && state.playlist.length > 0) {
      advanceToNextTrack();
    }
    return;
  }

  // API: Status (live from memory)
  if (pathPart === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    const statusObj = {
      status: isPlaying ? 'playing' : 'idle',
      currentTrack: currentTrackData,
      currentTrackIndex: state.currentTrackIndex,
      bitrate: currentTrackBitrate,
      channels: currentTrackChannels,
      sampleRate: currentTrackSampleRate,
      byteOffset: currentByteOffset,
      fileSize: currentTrackFileSize,
      percentage: currentTrackFileSize > 0 ? Math.round((currentByteOffset / currentTrackFileSize) * 10000) / 100 : 0,
      elapsedSec: Math.round((Date.now() - trackStartTime) / 1000 * 1000) / 1000,
      listeners: manifold.getActiveCount(),
      timestamp: new Date().toISOString(),
    };
    res.end(JSON.stringify(statusObj));
    return;
  }

  // API: Status file (on-disk status.json)
  if (pathPart === '/api/status.json') {
    if (fs.existsSync(STATUS_PATH)) {
      serveStaticFile(res, STATUS_PATH, 'application/json; charset=utf-8');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"status":"idle","currentTrack":null}');
    }
    return;
  }

  // Ops: skip the current track (advances to the next track — the most recently published unplayed item).
  if (pathPart === '/api/skip' && params.get('pass') === '7dco2P1WQShV5lbqMuxu') {
    if (isPlaying && currentTrackData) {
      // Mark the current track as aired (completed podcast / recently played
      // grabby) so advanceToNextTrack() does not re-pick it.
      markTrackPlayed(currentTrackData);
    }
    advanceToNextTrack();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: Playlist (filtered from index)
  if (pathPart === '/api/playlist') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    // Return playlist tracks with channel info + completed status
    const tracks = state.playlist.map(t => ({
      id: t.id,
      videoId: t.videoId,
      title: t.title,
      author: t.author,
      duration: t.duration,
      thumbnailPath: t.thumbnailPath,
      channel: t.channel ? { title: t.channel.title } : null,
      source: t.source || 'main',
      completed: state.completedTracks.has(t.id) || state.grabbyPlayed.has(t.id),
    }));
    const payload = {
      tracks,
      currentTrackIndex: state.currentTrackIndex,
    };
    res.end(JSON.stringify(payload));
    return;
  }

  // API: Index file (on-disk index.json)
  if (pathPart === '/api/index.json') {
    if (fs.existsSync(INDEX_JSON_PATH)) {
      serveStaticFile(res, INDEX_JSON_PATH, 'application/json; charset=utf-8');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // API: Shoutcast listing status (server-poll cache; drives the UI card)
  if (pathPart === '/api/shoutcast') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(shoutcastStatus));
    return;
  }

  // API: Thumbnail
  if (pathPart === '/api/thumb') {
    const thumbPath = params.get('path');
    if (!thumbPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing path parameter');
      return;
    }
    serveThumb(res, thumbPath);
    return;
  }

  // Web player (root)
  if (pathPart === '/') {
    const playerPath = path.join(PUBLIC_DIR, 'player.html');
    if (fs.existsSync(playerPath)) {
      serveStaticFile(res, playerPath, 'text/html; charset=utf-8');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>FrogRock Radio</h1><p><a href="/stream.mp3">Listen Live</a></p></body></html>');
    }
    return;
  }

  // Static files from public/
  if (pathPart.startsWith('/static/')) {
    const fileName = pathPart.slice(8); // remove /static/
    const filePath = path.join(PUBLIC_DIR, fileName);
    // Prevent directory traversal
    if (filePath.startsWith(PUBLIC_DIR)) {
      serveStaticFile(res, filePath);
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ====================== STARTUP ======================
server.listen(PORT, () => {
  console.log(`FrogRock BROADCAST server listening on http://localhost:${PORT}/stream.mp3`);
  console.log(`  → Per-client ICY manifold (queue max: ${CLIENT_QUEUE_MAX_BYTES}B, lag limit: ${CLIENT_LAG_MAX_MS}ms)`);
  console.log(`  → New-client burst: ${BURST_DURATION_SEC}s / metaint+metadata (frame-aligned, per-track)`);
  console.log(`  → Slow clients are dropped automatically`);

  refreshPlaylist();

  // Shoutcast listing status: first poll now, then every SHOUTCAST_POLL_MS
  pollShoutcast();
  setInterval(pollShoutcast, SHOUTCAST_POLL_MS);

  setTimeout(() => {
    if (state.playlist.length > 0 && !isPlaying) {
      advanceToNextTrack();
    }
  }, 500);

  setInterval(refreshPlaylist, 5 * 60 * 1000);
  setInterval(writeStatus, 1000);
  writeStatus();
});

server.on('error', (err: Error) => {
  console.error('Server error:', err);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  writeStatus();
  isPlaying = false;
  for (const client of manifold.clients) {
    client.disconnect('Server shutdown');
  }
  server.close(() => process.exit(0));
});
