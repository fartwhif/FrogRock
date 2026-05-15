# FrogRock Testing Guide

This document explains how to properly test the **FrogRock broadcast server** using the improved `test.sh` script.

---

## Overview

The test validates that the server correctly implements:

- **True broadcast model** — multiple clients receive identical audio at the same time
- **Real-time pacing** (~128 kbps delivery, not full-speed file dumping)
- **Valid ICY/Shoutcast streaming headers**
- **Proper live stream startup** and track broadcasting
- **Clean shutdown behavior**

The test is designed for the **new architecture** (single live source + immutable global state). It will **not** pass reliably with older versions of the server.

---

## Prerequisites

Before running the test, ensure you have:

1. **Node.js 18+** installed
2. The TypeScript source `server.ts` (or compiled `dist/server.js`) in the same directory
   - `index.json.example` is provided as the authoritative reference for the full expected structure
3. A valid DrivePod cache at `/media/sf_projects/DrivePod/cache` containing:
   - `index.json` matching the exhaustive structure in `index.json.example` (14+ fields including nested `channel`)
   - Audio files referenced by `audioPath` (and optionally `thumbnailPath` / `subtitlePath`)
4. `ffmpeg` installed (used for stream validation)
5. `curl` available (usually pre-installed)
6. The `test.sh` script is executable (`chmod +x test.sh`)
7. TypeScript installed (or `npx tsc` available) — the test script handles compilation automatically

> **Note:** If the cache is empty or missing, the server will still start but will log errors and have no audio to broadcast. The test will then fail at the "Broadcasting:" check.

---

## How to Run the Test

```bash
# The test script automatically compiles TypeScript if needed
./test.sh
```

Or manually:
```bash
npm run build
./test.sh
```

### What happens during the test:

1. Starts the FrogRock server in the background
2. **Waits** (up to 15 seconds) until it sees `"Broadcasting:"` in the log — this confirms the live stream has actually started
3. Runs 5 validation steps:
   - ICY headers check
   - ffmpeg stream validation (confirms valid MP3)
   - Audio capture test (~6 seconds of real audio)
   - Broadcast model test (connects a second client while streaming)
   - Server log summary
4. Cleans up and stops the server

**Expected runtime:** 20–30 seconds

---

## Expected Output (Successful Run)

```
🚀 Starting FrogRock BROADCAST server for testing...
Waiting for server to start broadcasting (max 15s)...
✅ Server is now broadcasting live audio

=== 1. ICY Headers (broadcast mode) ===
HTTP/1.1 200 OK
icy-name: FrogRock Radio
icy-br: 128
...

=== 2. Stream validation (ffmpeg probe) ===
✅ Stream is valid MP3 audio

=== 3. Audio capture (first ~6 seconds) ===
/tmp/test-stream.mp3: MPEG ADTS, layer III...
-rw-r--r-- 1 root root 95K ...

=== 4. Broadcast model test (multiple simultaneous clients) ===
Connecting second client while first is streaming...
icy-name: FrogRock Radio
icy-br: 128

=== 5. Server log summary ===
Recent log lines:
▶️  Broadcasting: Some Podcast Title
...

✅ All tests completed successfully!
   → Broadcast model working (multiple clients supported)
   → Real-time pacing active
   → ICY headers correct
   → Valid audio stream

🧹 Test finished. Server stopped.
```

---

## Success Criteria

The test passes if you see:

- `✅ Server is now broadcasting live audio`
- `✅ Stream is valid MP3 audio`
- `✅ All tests completed successfully!`
- No fatal errors in the final summary

---

## Troubleshooting

### "Server did not start broadcasting within 15 seconds"

**Cause:** The server could not load the playlist (usually missing `index.json` or permission issues on the cache directory).

**Fix:**
```bash
tail -50 frogrock.log
```
Look for errors like:
- `index file not found`
- `Error reading index file`
- Permission denied on `/media/sf_projects/...`

### ffmpeg probe shows warnings or fails

This is often normal in short tests. The important thing is that the server started broadcasting and the audio capture step produced a valid `.mp3` file.

### Test hangs or takes too long

The smart wait loop should exit within 15 seconds. If it hangs:
- Kill any stray `node server.js` processes
- Check that port 8090 is free: `lsof -i :8090`

### "No tracks" or empty playlist

The server started but has nothing to play. This usually means `index.json` is empty or all tracks are marked completed. The test will fail at the broadcasting check.

---

## Manual Testing (Recommended After Automated Test)

After `test.sh` passes, try these manual checks:

1. **Listen live**
   ```bash
   # In VLC or any player
   http://localhost:8090/stream.mp3
   ```

2. **Verify multiple clients hear the same track**
   - Open two separate players or browser tabs to the stream
   - They should be playing the **exact same track** at the same position

3. **Check real-time pacing**
   - While listening, run:
     ```bash
     curl -sI http://localhost:8090/stream.mp3 | grep icy-br
     ```
   - The server should deliver audio at ~128 kbps (not instantly dump the whole file)

4. **View current state**
   - Watch the server console — it logs every track it starts broadcasting

---

## Notes

- The test is **non-destructive** — it does not modify `completed.json` permanently (the server does mark tracks completed, but the test resets on full playlist cycle).
- The test works best when the cache has **at least 3–5 tracks**.
- For CI/CD environments, you can run `./test.sh` as part of your pipeline (it exits with code 0 on success).

---

**FrogRock is now properly testable.** Run `./test.sh` whenever you make changes to `server.ts` to ensure the broadcast model, pacing, and headers remain correct.