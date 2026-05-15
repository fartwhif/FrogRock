#!/bin/bash

# FrogRock Server Start Script (service-style with PID file management)

PIDFILE="server.linux.pid"
LOGFILE="frogrock.log"

# Parse command-line flags (supports multiple flags)
REBUILD=false
FORCE=false

for arg in "$@"; do
    case "$arg" in
        --rebuild|-r)
            REBUILD=true
            ;;
        --force|-f)
            FORCE=true
            ;;
    esac
done

# Handle rebuild request
if [ "$REBUILD" = true ]; then
    echo "🔄 Rebuild requested — removing old dist/ folder..."
    rm -rf dist
fi

# Smart dependency handling:
# - If dist/ already exists → we don't need npm or compilation at all (fast path)
# - Only attempt install + compile when we actually need to build from .ts
if [ -f "dist/server.js" ]; then
    NODE_SCRIPT="dist/server.js"
elif [ -f "server.ts" ]; then
    # We need to compile → ensure dependencies are present
    if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
        echo "📦 Installing dependencies (using --no-bin-links for VirtualBox/shared folder compatibility)..."
        npm install --no-bin-links || {
            echo "❌ npm install failed (EPERM symlink error is common on /media/sf_projects shared folders)"
            echo "   Quick fixes:"
            echo "     1. Move FrogRock folder outside /media/sf_projects/ (recommended)"
            echo "     2. rm -rf node_modules && npm install --no-bin-links"
            echo "     3. Or run: npm install --no-bin-links --legacy-peer-deps"
            exit 1
        }
        echo "✅ Dependencies installed."
    fi

    echo "📦 Compiling TypeScript..."
    COMPILE_OK=false
    if command -v tsc >/dev/null 2>&1; then
        if tsc --skipLibCheck; then COMPILE_OK=true; fi
    elif [ -x "./node_modules/.bin/tsc" ]; then
        if ./node_modules/.bin/tsc --skipLibCheck; then COMPILE_OK=true; fi
    elif [ -f "./node_modules/typescript/bin/tsc" ]; then
        if node "./node_modules/typescript/bin/tsc" --skipLibCheck; then COMPILE_OK=true; fi
    else
        echo "⚠️  No local tsc found after install, using npx fallback (may take a moment)..."
        if npx --yes -p typescript tsc --skipLibCheck; then COMPILE_OK=true; fi
    fi

    if [ "$COMPILE_OK" != true ]; then
        echo "❌ TypeScript compilation failed"
        exit 1
    fi
    NODE_SCRIPT="dist/server.js"
else
    NODE_SCRIPT="server.js"
fi

echo "🚀 Starting FrogRock server..."

# Check if PID file exists
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
    
    # Check if the process is actually running
    if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" > /dev/null 2>&1; then
        if [ "$FORCE" = true ]; then
            echo "⚠️  Force mode enabled. Killing existing server (PID: $OLD_PID)..."
            # Try graceful shutdown first
            kill -TERM "$OLD_PID" 2>/dev/null || true
            sleep 1
            # Force kill if still running
            kill -KILL "$OLD_PID" 2>/dev/null || true
            # Delete the old PID file as requested
            rm -f "$PIDFILE"
        else
            echo "❌ Server is already running with PID $OLD_PID."
            echo "   Use --force or -f to override."
            exit 1
        fi
    else
        # Stale PID file (process died but file remained)
        echo "⚠️  Found stale PID file (process not running). Removing it."
        rm -f "$PIDFILE"
    fi
fi

# Start the Node.js server in the background
echo "Starting node process in background..."
node "$NODE_SCRIPT" > "$LOGFILE" 2>&1 &
NEW_PID=$!

# Write the new PID to server.linux.pid
echo "$NEW_PID" > "$PIDFILE"

echo "✅ FrogRock server started successfully!"
echo "   PID: $NEW_PID"
echo "   PID file: $PIDFILE"
echo "   Logs: $LOGFILE"

echo ""
echo "Usage examples:"
echo "  ./serve.sh                 # Normal start (uses existing dist/ if present)"
echo "  ./serve.sh --force         # Restart (kill existing)"
echo "  ./serve.sh --rebuild       # Fresh TypeScript build"
echo "  ./serve.sh -r --force      # Rebuild + force restart"
echo ""
echo "Stream URL: http://localhost:8090/stream.mp3"