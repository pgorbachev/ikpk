#!/bin/bash
# Stable preview server for IKPK site
# Usage: ./serve.sh [port]
# Stops any existing server on the port, rebuilds, and starts a new one.

PORT=${1:-4322}
DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill existing server on this port
existing=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$existing" ]; then
  echo "Stopping existing server (PID $existing)..."
  kill $existing 2>/dev/null
  sleep 1
fi

# Build
echo "Building site..."
cd "$DIR" && npm run build 2>&1 | tail -3

# Start server (nohup + disown to survive shell close)
nohup python3 -m http.server $PORT --directory "$DIR/dist" --bind 0.0.0.0 \
  </dev/null >/tmp/ikpk-server.log 2>&1 &
SERVER_PID=$!
disown $SERVER_PID

sleep 1
if curl -s -o /dev/null -w "" http://localhost:$PORT/; then
  echo "✓ Server running at http://localhost:$PORT/ (PID $SERVER_PID)"
else
  echo "✗ Server failed to start"
  exit 1
fi
