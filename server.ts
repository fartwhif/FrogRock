// server.ts
// Broadcast-mode FrogRock server with:
// - Global IMMUTABLE state (updates create new objects/Sets)
// - Single live audio source → all clients hear exactly the same thing at the same time
// - Clients join the LIVE position (no per-client control over playback)
// - Real-time pacing (~128 kbps)
// - Completed track skipping + auto-reset
// - Exhaustive typing based on real DrivePod index.json.example structure

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';

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
// ====================== STARTUP CHECKS ======================
if (CACHE_DIR === 'UNCONFIGURED') {
  console.error('ERROR: CACHE_DIR environment variable is not set. Please set CACHE_DIR to the path of your cache directory.');
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

// ====================== ACTIVE CLIENTS (broadcast) ======================
const activeClients = new Set<http.ServerResponse>();
let currentReadStream: fs.ReadStream | null = null;
let currentTrackData: Track | null = null;
let currentByteOffset = 0;


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

// ====================== BROADCAST STREAMING ======================
function startCurrentTrack(): void {
  if (currentReadStream) {
    currentReadStream.destroy();
    currentReadStream = null;
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

  currentTrackData = track;
  currentByteOffset = 0;

  const displayTitle = track.title || path.basename(filePath);
  const channelInfo = track.channel?.title ? ` [${track.channel.title}]` : '';
  console.log(`▶️  Broadcasting: ${displayTitle}${channelInfo}`);

  currentReadStream = fs.createReadStream(filePath, {
    highWaterMark: 16384,
  });

  const BITRATE_BPS = 128 * 1024;
  const startTime = Date.now();

  currentReadStream.on('data', (chunk: Buffer | string) => {
    const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string);
    currentByteOffset += chunkLength;

    const disconnected: http.ServerResponse[] = [];
    for (const res of activeClients) {
      if (res.writable && !res.writableEnded) {
        res.write(chunk);
      } else {
        disconnected.push(res);
      }
    }
    for (const res of disconnected) {
      activeClients.delete(res);
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const expectedBytes = elapsedSec * (BITRATE_BPS / 8);
    const bufferAhead = currentByteOffset - expectedBytes;

    if (bufferAhead > 32768) {
      currentReadStream?.pause();
      setTimeout(() => {
        if (currentReadStream && !currentReadStream.destroyed) {
          currentReadStream.resume();
        }
      }, 150);
    }
  });

  currentReadStream.on('end', () => {
    console.log(`✓ Finished: ${track.title || path.basename(filePath)}`);

    const newCompleted = new Set(state.completedTracks);
    newCompleted.add(track.id);
    updateState({ completedTracks: newCompleted });
    saveCompletedTracks();

    advanceToNextTrack();
  });

  currentReadStream.on('error', (err: Error) => {
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
    console.log('New client connected — joining live broadcast');

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'icy-name': 'FrogRock Radio',
      'icy-description': 'DrivePod Radio Stream (Live)',
      'icy-genre': 'Podcast',
      'icy-pub': '1',
      'icy-br': '128',
      'icy-metaint': '16000',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    activeClients.add(res);

    req.on('close', () => {
      activeClients.delete(res);
      console.log('Client disconnected (remaining: ' + activeClients.size + ')');
    });

    if (!currentReadStream && state.playlist.length > 0) {
      startCurrentTrack();
    }

  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Only /stream.mp3 is available');
  }
});

// ====================== STARTUP ======================
server.listen(PORT, () => {
  console.log(`🚀 FrogRock BROADCAST server listening on http://localhost:${PORT}/stream.mp3`);
  console.log('   → All clients hear the exact same live stream');
  console.log('   → Global state is immutable');
  console.log('   → Clients have ZERO control over playback position');

  refreshPlaylist();

  setTimeout(() => {
    if (state.playlist.length > 0 && !currentReadStream) {
      startCurrentTrack();
    }
  }, 500);

  setInterval(refreshPlaylist, 5 * 60 * 1000);
});

server.on('error', (err: Error) => {
  console.error('Server error:', err);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (currentReadStream) currentReadStream.destroy();
  for (const res of activeClients) res.end();
  server.close(() => process.exit(0));
});
