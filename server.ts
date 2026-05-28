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
import CodecParser, { CodecFrame, MPEGHeader } from 'codec-parser';
import { Writer } from './src/icy-writer';

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
}

interface AppState {
  playlist: readonly Track[];
  currentTrackIndex: number;
  completedTracks: ReadonlySet<string>;
  currentTrackStartTime: number;
}

type StatePartial = Partial<{
  playlist: Track[];
  currentTrackIndex: number;
  completedTracks: Set<string>;
  currentTrackStartTime: number;
}>;

// ====================== CONSTANTS ======================
const PORT = parseInt(process.env.PORT || '8090', 10);
const CACHE_DIR = process.env.CACHE_DIR || 'UNCONFIGURED';
const INDEX_JSON_PATH = path.join(CACHE_DIR, 'index.json');
const COMPLETED_TRACKS_PATH = path.join(CACHE_DIR, 'completed.json');
const STATUS_PATH = path.join(CACHE_DIR, 'status.json');
const METAIMNT_TARGET = 16000;
const MAX_METADATA_LEN = 255;

// Per-client queue settings (Icecast-style backpressure)
const CLIENT_QUEUE_MAX_BYTES = parseInt(process.env.CLIENT_QUEUE_MAX_BYTES || '65536', 10);
const CLIENT_LAG_MAX_MS = parseInt(process.env.CLIENT_LAG_MAX_MS || '10000', 10);

// Burst buffer for new-client prebuffering (duration in seconds, resized per track)
const BURST_DURATION_SEC = parseInt(process.env.BURST_DURATION_SEC || '8', 10);

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
  currentTrackStartTime: Date.now(),
});

function updateState(partial: StatePartial): void {
  const newPlaylist = partial.playlist
    ? Object.freeze([...partial.playlist])
    : state.playlist;

  const newCompleted = partial.completedTracks
    ? Object.freeze(new Set(partial.completedTracks))
    : state.completedTracks;

  const newState: AppState = {
    ...state,
    ...partial,
    playlist: newPlaylist,
    completedTracks: newCompleted,
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
  public writer: Writer;
  private queueBytes: number = 0;
  private lastDataTime: number = Date.now();
  private disconnected: boolean = false;

  constructor(res: http.ServerResponse) {
    this.res = res;
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
  }

  formatMetadata(title: string, artist: string, channel: string): string {
    const raw = `${artist} - ${title}`;
    return raw.length > MAX_METADATA_LEN ? raw.slice(0, MAX_METADATA_LEN) : raw;
  }

  queueMetadata(title: string, artist: string, channel: string): void {
    if (this.disconnected) return;
    try {
      const metaStr = this.formatMetadata(title, artist, channel);
      this.writer.queue({ StreamTitle: ` ${metaStr};` });
    } catch (err) {
      console.error('Metadata queue error:', err);
    }
  }

  writeAudio(chunk: Buffer): boolean {
    if (this.disconnected) return false;

    const ok = this.writer.write(chunk);
    this.lastDataTime = Date.now();

    if (!ok) {
      this.queueBytes += chunk.length;
    }

    if (this.queueBytes > CLIENT_QUEUE_MAX_BYTES) {
      this.disconnect('Client queue overflow (fell too far behind)');
      return false;
    }

    return ok;
  }

  burstFromBuffer(buffer: BurstBuffer): void {
    if (this.disconnected) return;
    const data = buffer.peek();
    if (data.length > 0) {
      this.writer.write(data);
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
    console.log(`  ✗ Dropped client: ${reason}`);
    try {
      this.writer.destroy();
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

// ====================== ACTIVE STREAM STATE ======================
let isPlaying = false;
let currentTrackData: Track | null = null;
let currentByteOffset = 0;
let trackStartTime = Date.now();
let currentTrackBitrate = 0;
let currentTrackFileSize = 0;
let currentFrameSize = 417;
let currentMetaint = METAIMNT_TARGET;

// ====================== PLAYLIST MANAGEMENT ======================
function refreshPlaylist(): void {
  if (!fs.existsSync(INDEX_JSON_PATH)) {
    console.error(`index file not found: ${INDEX_JSON_PATH}`);
    return;
  }

  let newCompleted = new Set(state.completedTracks);

  try {
    if (fs.existsSync(COMPLETED_TRACKS_PATH)) {
      const completedData = fs.readFileSync(COMPLETED_TRACKS_PATH, 'utf8');
      const parsed = JSON.parse(completedData);
      if (Array.isArray(parsed)) {
        newCompleted = new Set(parsed as string[]);
      }
    }
  } catch (e) {
    console.error('Error loading completed tracks:', e);
  }

  try {
    const indexData = fs.readFileSync(INDEX_JSON_PATH, 'utf8');
    const index = JSON.parse(indexData);

    let newPlaylist: Track[] = [];
    if (Array.isArray(index)) {
      newPlaylist = index
        .filter((item): item is Track => Boolean(item && item.audioPath));
    }

    updateState({
      playlist: newPlaylist,
      completedTracks: newCompleted,
    });

    console.log(`Playlist refreshed — ${newPlaylist.length} tracks`);
  } catch (error) {
    console.error('Error reading index file:', error);
  }
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

// ====================== FRAME PROBING ======================
function probeFirstFrames(filePath: string, startOffset: number): {
  bitrate: number;
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
  const frameSize = Math.max(...frames.slice(0, 5).map(f => f.data.length));

  return { bitrate, frameSize, frames };
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
    bitrate: currentTrackBitrate,
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
function startCurrentTrack(): void {
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

  let startOffset = 0;
  try {
    const fd = fs.openSync(filePath, 'r');
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

  currentTrackData = track;
  currentByteOffset = 0;
  trackStartTime = Date.now();
  currentTrackFileSize = fs.statSync(filePath).size;

  const { bitrate, frameSize, frames: probeFrames } = probeFirstFrames(filePath, startOffset);
  currentTrackBitrate = bitrate;
  currentFrameSize = frameSize;

  // Calculate metaint as a multiple of frame size to avoid splitting MP3 frames
  const framesPerMeta = Math.round(METAIMNT_TARGET / frameSize);
  currentMetaint = framesPerMeta * frameSize;

  const burstCapacityFrames = computeBurstCapacity(currentFrameSize, currentTrackBitrate);
  audioBuffer = new BurstBuffer(burstCapacityFrames);

  const displayTitle = track.title || path.basename(filePath);
  const channelInfo = track.channel?.title ? ` [${track.channel.title}]` : '';
  console.log(`▶️  Broadcasting: ${displayTitle}${channelInfo} (startOffset: ${startOffset}, bitrate: ${currentTrackBitrate / 1000}kbps, frameSize: ${currentFrameSize}, metaint: ${currentMetaint} (${framesPerMeta} frames), burst: ${burstCapacityFrames} frames)`);

  manifold.broadcastMetadata(
    track.title || path.basename(filePath),
    track.author,
    track.channel?.title ?? 'Unknown'
  );

  for (const frame of probeFrames) {
    manifold.broadcastAudio(
      Buffer.from(frame.data),
      track.title || path.basename(filePath),
      track.author,
      track.channel?.title ?? 'Unknown',
      trackStartTime
    );
  }

  isPlaying = true;
  const probeBytesConsumed = probeFrames.reduce((sum, f) => sum + f.data.length, 0);
  const fd = fs.openSync(filePath, 'r');
  const audioBytes = currentTrackFileSize - startOffset;
  const contentLengthSec = audioBytes / (currentTrackBitrate / 8);
  const parser = new CodecParser('audio/mpeg', { enableFrameCRC32: false });
  const streamLoop = async () => {
    const t = Date.now();
    let sent = startOffset + probeBytesConsumed;

    while (sent < currentTrackFileSize) {
      const g = (Date.now() - t) / 1000;
      const shouldHaveSent = (g / contentLengthSec) * audioBytes + startOffset;
      const behind = shouldHaveSent - sent;

      if (behind > 0) {
        const readSize = Math.min(Math.ceil(behind), 8192, currentTrackFileSize - sent);
        const buf = Buffer.alloc(readSize);
        const bytesRead = fs.readSync(fd, buf, 0, readSize, sent);

        if (bytesRead > 0) {
          sent += bytesRead;
          currentByteOffset = sent;
          const frames = [...parser.parseChunk(buf.slice(0, bytesRead)) as unknown as Generator<CodecFrame>];
          for (const frame of frames) {
            manifold.broadcastAudio(
              Buffer.from(frame.data),
              track.title || path.basename(filePath),
              track.author,
              track.channel?.title ?? 'Unknown',
              trackStartTime
            );
          }
          manifold.prune();
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    for (const frame of parser.flush() as unknown as Generator<CodecFrame>) {
      manifold.broadcastAudio(
        Buffer.from(frame.data),
        track.title || path.basename(filePath),
        track.author,
        track.channel?.title ?? 'Unknown',
        trackStartTime
      );
    }
    manifold.prune();
    fs.closeSync(fd);
    console.log(`✓ Finished: ${track.title || path.basename(filePath)}`);

    const newCompleted = new Set(state.completedTracks);
    newCompleted.add(track.id);
    updateState({ completedTracks: newCompleted });
    saveCompletedTracks();

    advanceToNextTrack();
  };

  streamLoop().catch((err: Error) => {
    try { fs.closeSync(fd); } catch {}
    console.error('Stream error:', err.message);
    advanceToNextTrack();
  });
}

function advanceToNextTrack(): void {
  let attempts = 0;
  const maxAttempts = state.playlist.length || 1;

  let nextIndex = state.currentTrackIndex + 1;
  if (nextIndex >= state.playlist.length) {
    nextIndex = 0;
  }

  while (
    attempts < maxAttempts &&
    state.playlist[nextIndex] &&
    state.completedTracks.has(state.playlist[nextIndex].id)
  ) {
    nextIndex = (nextIndex + 1) % state.playlist.length;
    attempts++;
  }

  if (attempts >= maxAttempts) {
    console.log('All tracks completed — resetting playlist');
    const emptyCompleted = new Set<string>();
    updateState({
      currentTrackIndex: 0,
      completedTracks: emptyCompleted,
    });
    saveCompletedTracks();
    nextIndex = 0;
  }

  updateState({
    currentTrackIndex: nextIndex,
    currentTrackStartTime: Date.now(),
  });

  startCurrentTrack();
}

// ====================== HTTP SERVER ======================
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/stream.mp3' || req.url === '/' || req.url === '/stream') {
    console.log(`New client connected (active: ${manifold.getActiveCount() + 1})`);

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'icy-name': 'FrogRock Radio',
      'icy-description': 'DrivePod Radio Stream (Live)',
      'icy-genre': 'Podcast',
      'icy-pub': '1',
      'icy-br': String(currentTrackBitrate ? Math.round(currentTrackBitrate / 1000) : 128),
      'icy-metaint': String(currentMetaint),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'close',
       'Transfer-Encoding': 'identity',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    const client = new ClientConnection(res);
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
      startCurrentTrack();
    }

  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Only /stream.mp3 is available');
  }
});

// ====================== STARTUP ======================
server.listen(PORT, () => {
  console.log(`FrogRock BROADCAST server listening on http://localhost:${PORT}/stream.mp3`);
  console.log(`  → Per-client ICY manifold (queue max: ${CLIENT_QUEUE_MAX_BYTES}B, lag limit: ${CLIENT_LAG_MAX_MS}ms)`);
  console.log(`  → New-client burst: ${BURST_DURATION_SEC}s / metaint+metadata (frame-aligned, per-track)`);
  console.log(`  → Slow clients are dropped automatically`);

  refreshPlaylist();

  setTimeout(() => {
    if (state.playlist.length > 0 && !isPlaying) {
      startCurrentTrack();
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
