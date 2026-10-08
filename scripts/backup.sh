#!/usr/bin/env bash
# BunkCraft: backup of the whole data directory (main world, every game, bans, player profiles and the token
# secret profiles/secret.key) from the Docker volume to the host.
#
#   ./scripts/backup.sh [--dest /var/backups/bunkcraft] [--keep 14]
#
# Writes <dest>/bunkcraft-YYYYmmdd-HHMMSS.tar.gz and keeps the newest --keep archives. Safe while players are
# online: the server writes every world and profile file atomically (temp file + rename). The server's own rotating
# copies (data/backups) are left out; they are copies of the same files. Losing profiles/secret.key invalidates
# every player's profile token, so the archive must always contain it: this script warns when it does not.
#
# Restore (stops the game for a moment):
#   docker compose stop bunkcraft
#   docker compose run --rm --no-deps -T --entrypoint sh bunkcraft \
#     -c 'rm -rf /app/data/* && tar -xzf - -C /app' < /var/backups/bunkcraft/bunkcraft-….tar.gz
#   docker compose up -d
set -euo pipefail

DEST="${BUNKCRAFT_BACKUP_DIR:-/var/backups/bunkcraft}"
KEEP=14
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?}"; shift 2 ;;
    --keep) KEEP="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
cd "$(dirname "$(readlink -f "$0")")/.."

mkdir -p "$DEST"
chmod 700 "$DEST"
file="$DEST/bunkcraft-$(date +%Y%m%d-%H%M%S).tar.gz"
tar_args=(-czf - --exclude=data/backups --exclude='*.tmp' -C /app data)
if [ -n "$(docker compose ps -q --status running bunkcraft 2>/dev/null)" ]; then
  docker compose exec -T bunkcraft tar "${tar_args[@]}" >"$file.part"
else
  # Stopped: read the volume through a throw-away container of the same image.
  docker compose run --rm --no-deps -T --entrypoint tar bunkcraft "${tar_args[@]}" >"$file.part"
fi
# An empty or broken archive must never replace a good one.
gzip -t "$file.part"
mv "$file.part" "$file"
# Profiles (and the secret that signs their tokens) are part of the data directory; say so when they are missing.
if [ "$(tar -tzf "$file" | grep -c '^data/profiles/secret.key$' || true)" -eq 0 ]; then
  echo "warning: $file has no data/profiles/secret.key (profiles switched off, or PROFILE_SECRET set and kept elsewhere)" >&2
fi
echo "backup: $file ($(du -h "$file" | cut -f1))"

# Keep the newest $KEEP archives.
# shellcheck disable=SC2012  # our own file names, no spaces
ls -1t "$DEST"/bunkcraft-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f -- "$old"; done
