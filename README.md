# FrogRock Streaming Server

**Corrected & Production-Ready Broadcast Radio Server**

FrogRock is a lightweight Node.js HTTP streaming server that turns a DrivePod cache into a live internet radio station. It implements a **true broadcast model**: one live audio source, many listeners, all hearing exactly the same content at the same time.

---

## Core Philosophy

- **Global immutable state** — playlist, current position, and completed tracks are never mutated in place. Every update creates a fresh frozen object.
- **Single live broadcast** — all connected clients receive identical audio bytes at the exact same wall-clock time.
- **Clients have zero control** over playback position. New listeners instantly join the live stream wherever it currently is (standard radio behavior).
- **Real-time pacing** — audio is delivered at approximately the target bitrate (~128 kbps) instead of blasting entire tracks.

---

## Previous Incorrect Assumptions

The original implementation and README contained several deep misconceptions about streaming:

| Incorrect Assumption | Reality & Fix |
|----------------------|---------------|
| "Simple `createReadStream` + sequential chaining = time flow simulation + 10-second buffer + seamless merging over blank stream" | **Completely false.** The old code just dumped files at disk speed. Now we have explicit real-time pacing and a single shared stream. |
| "Each client can have its own playback position" | **Wrong for radio.** Now uses one `currentReadStream` + `activeClients` Set. All clients are locked together. |
| "We can mutate global `PLAYLIST`, `currentTrackIndex`, and `completedTracks` freely" | Now uses `updateState()` + `Object.freeze()` — every change produces a new immutable state object. |
| "ICY headers + file streaming = proper radio experience" | Headers were set but no metadata was ever sent and there was no pacing. Now includes proper headers + pacing logic. |
| "Track transitions are automatically gapless" | Still not perfectly gapless (small JS event-loop gap), but far more reliable due to single shared stream. |
| "The server only needs to serve files" | A real radio server must broadcast one source to many clients and control the timeline. This is now the architecture. |

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GLOBAL IMMUTABLE STATE                    │
│  { playlist: frozen[], currentTrackIndex, completedTracks }  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Single Live Source │
                    │  currentReadStream  │
                    │  (paced @ ~128kbps) │
                    └─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        Client A        Client B        Client C
     (joined live)   (joined live)   (joined live)
```

- One background `fs.createReadStream` drives the entire station.
- Every audio chunk is written to **all** active clients simultaneously.
- New clients are added to the broadcast and start receiving from the current moment.
- When a track ends, the server atomically advances the immutable state and starts the next track for everyone.

---

## Features

- **True broadcast radio** — all listeners synchronized
- **Immutable global state** — safe, predictable, no race conditions
- **Real-time pacing** — prevents clients from buffering hours of future content
- **Completed track tracking** — automatically skips already-played episodes
- **Automatic playlist refresh** every 5 minutes
- **ICY/Shoutcast compatible headers**
- **Graceful handling** of missing files and stream errors
- **Zero client control** over playback position

---

## TypeScript Support

FrogRock is now written in **TypeScript** for better maintainability, type safety, and developer experience.

- Source: `server.ts`
- Compiled output: `dist/server.js` (via `tsc`)
- `tsconfig.json` included with strict mode, source maps, and declarations
- `package.json` provides convenient scripts: `build`, `start`, `dev`, `serve`, `test`

**Requirements for development:**
- Node.js 18+
- TypeScript (`npm install` for dev deps)
- Optional: `ts-node` for `npm run dev`

The compiled JavaScript remains fully compatible with the original runtime behavior.

---

## Usage

### Start the server

```bash
# Recommended (TypeScript source)
npm run build && npm start
# or
./serve.sh

# Development (with ts-node)
npm run dev
```

The stream is available at:

```
http://localhost:8090/stream.mp3
```

### Connect with any player

- VLC: `Media → Open Network Stream`
- foobar2000, Winamp, iTunes, etc. — just paste the URL
- Web players, Sonos, smart speakers — works with any ICY-compatible client

### Starting the server (recommended)

```bash
./serve.sh
```

`serve.sh` is now very smart:
- If `dist/frogrock-server.js` already exists → starts instantly (no npm, no compilation)
- If you need to rebuild from TypeScript → use `--rebuild`
- Automatically installs dependencies only when needed (with VirtualBox/shared-folder fixes)
- Supports these flags:

| Flag              | Description |
|-------------------|-------------|
| `--force`, `-f`   | Kill any running server and restart |
| `--rebuild`, `-r` | Force clean rebuild from `frogrock-server.ts` |

**Examples:**
```bash
./serve.sh                 # Normal start
./serve.sh --force         # Restart (kill existing)
./serve.sh --rebuild       # Fresh TypeScript build
./serve.sh -r --force      # Rebuild + force restart
```

---

## Technical Details

### State Management (Immutable)

```js
let state = Object.freeze({ playlist: [], currentTrackIndex: 0, completedTracks: new Set() });

function updateState(partial) {
  // Always creates a brand new frozen object
  state = Object.freeze({ ...state, ...partial, playlist: Object.freeze([...]), ... });
}
```

### Broadcast Mechanism

- Single `currentReadStream` for the entire station
- `activeClients = new Set()` of all connected `http.ServerResponse` objects
- Every `'data'` event writes the same chunk to every client
- New clients instantly join the live position

### Real-time Pacing

The server monitors bytes sent vs. elapsed time and automatically pauses/resumes the source stream to stay close to the target bitrate (default 128 kbps). This gives clients a healthy rolling buffer (~2 seconds) without allowing them to download the entire future playlist.

### Completed Tracks

- Tracks are marked completed only after they finish streaming to the broadcast.
- On playlist refresh or track advance, completed tracks are skipped.
- When the entire playlist has been played, the completed set is reset.

---

## File Structure

- `server.ts` — primary TypeScript source (compiles to `dist/server.js`)
- `index.json` — DrivePod cache index (in `CACHE_DIR`) — full structure per `index.json.example`
- `index.json.example` — complete example of real DrivePod index structure (14 fields + nested `channel`)
- `completed.json` — persisted list of played track IDs (uses `id` field)
- `serve.sh` — Linux startup script with automatic dependency installation, TypeScript compilation, `--force`, and `--rebuild` support

- `tsconfig.json` + `package.json` — TypeScript configuration and npm scripts

---

## Requirements

- Node.js 18+
- Read access to `CACHE_DIR` (default: `/media/sf_projects/DrivePod/cache`)
- The DrivePod cache must contain `index.json` matching the full structure in `index.json.example`

---

## Notes

- This server is designed for **one logical radio station**. It is not a multi-user on-demand player.
- Mid-track joins are normal and expected behavior for live radio.
- For perfect gapless playback across track boundaries, consider adding an `ffmpeg` concat stage in the future (not currently implemented).
- The server logs the currently broadcasting track title to the console.

---

**FrogRock is now a correct, honest implementation of a live radio broadcaster.** No more misleading claims about time simulation or per-client control. Just reliable, synchronized streaming with immutable state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                