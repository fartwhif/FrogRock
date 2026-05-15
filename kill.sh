#!/bin/bash

# FrogRock Server Force Kill Script
# This script kills the currently running FrogRock server

PIDFILE="server.linux.pid"

# Check if PID file exists
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
    
    # Check if the process is actually running
    if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "🛑 Killing FrogRock server (PID: $OLD_PID)..."
        # Try graceful shutdown first
        kill -TERM "$OLD_PID" 2>/dev/null || true
        sleep 1
        # Force kill if still running
        kill -KILL "$OLD_PID" 2>/dev/null || true
        # Delete the PID file
        rm -f "$PIDFILE"
        echo "✅ FrogRock server stopped successfully!"
    else
        # Stale PID file (process died but file remained)
        echo "⚠️  Found stale PID file (process not running). Removing it."
        rm -f "$PIDFILE"
    fi
else
    echo "❌ No running FrogRock server found (no PID file)."
fi