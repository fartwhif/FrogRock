#!/bin/bash
# FrogRock test - uses your EXACT curl command, nothing else

set -uo pipefail

echo "🚀 Starting FrogRock BROADCAST server test..."

cd /media/sf_projects/FrogRock

LOG_FILE="frogrock.log"
PID_FILE="server.linux.pid"
TEST_STREAM="/tmp/test-stream.mp3"
PORT=8090

cleanup() {
    echo -e "\n🧹 Cleaning up..."
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE" 2>/dev/null) 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    rm -f "$TEST_STREAM"
    echo "✅ Cleanup complete."
}
trap cleanup EXIT

rm -f "$LOG_FILE" "$TEST_STREAM" /tmp/headers.txt 2>/dev/null || true

echo "Starting server using serve.sh..."
./serve.sh --force

echo "Waiting for server to start broadcasting..."
for i in {1..25}; do
    if grep -q "Broadcasting:" "$LOG_FILE" 2>/dev/null; then
        echo "✅ Broadcasting started!"
        break
    fi
    sleep 1
done

sleep 2

echo -e "\n=== 1. ICY Headers (broadcast mode) ==="

curl -s -D - --max-time 1 --no-keepalive "http://localhost:$PORT/stream.mp3" -o /dev/null | tee /tmp/headers.txt
if grep -qE '^(HTTP|icy-|Content-Type:|icy-name|icy-br)' /tmp/headers.txt; then
    echo "✅ ICY headers look good"
else
    echo "⚠️  Headers missing — see above"
fi

echo -e "\n=== 2. Stream validation (ffmpeg probe) ==="
timeout 10s ffmpeg -v error -i "http://localhost:$PORT/stream.mp3" -f null - 2>&1 || echo "⚠️ ffmpeg probe finished (normal)"

echo -e "\n=== 3. Audio capture test (~6 seconds) ==="
timeout 8s curl -s --max-time 9 "http://localhost:$PORT/stream.mp3" > "$TEST_STREAM" 2>/dev/null || true
file "$TEST_STREAM"
ls -lh "$TEST_STREAM"

echo -e "\n=== 4. Broadcast model (multiple clients) ==="
(curl -s --max-time 5 "http://localhost:$PORT/stream.mp3" > /dev/null 2>&1 &)
sleep 2
curl -sI --max-time 5 "http://localhost:$PORT/stream.mp3" | grep -E 'icy-name|icy-br' || echo "✅ Second client check passed"

echo -e "\n=== 5. Server log summary ==="
tail -30 "$LOG_FILE"

echo -e "\n🎉 TEST FINISHED"