#!/bin/sh
# Run as the user Unraid (or any host) expects, and make sure the data dir is writable.
set -e

PUID="${PUID:-99}"     # Unraid default: nobody
PGID="${PGID:-100}"    # Unraid default: users
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/uploads"
  # Only fix ownership when it is wrong, so large upload folders aren't re-chowned on every start.
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ] || \
     [ -n "$(find "$DATA_DIR" ! -user "$PUID" 2>/dev/null | head -n 1)" ]; then
    echo "Setting ownership of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
