#!/usr/bin/env bash
# Install the Space Folders layout into the Herdr desktop app (Herdr App), so it
# looks like Studio's herdr page and shares its folders.
#
# What it does (idempotent; run it again to update):
#   1. Gets herdr-space-folders by Jan-Kees van Woezik (MIT,
#      github.com/jankeesvw/herdr-space-folders): clones it to
#      ~/.local/share/herdr-space-folders, or uses --from <checkout>.
#   2. Links its `space-folders` mod into ~/.config/herdr-app/mods/space-folders.
#   3. Copies its `main-folders` layout into ~/.config/herdr-app/layouts/.
#   4. Merges the `layout:main-folders` section of its keys.json (alt-up and
#      alt-down follow the folders) into ~/.config/herdr-app/keys.json, keeping
#      every key you set yourself; the old file is kept as keys.json.bak.
#   5. With --switch, tells a running Herdr App to switch to the layout.
#
# Herdr App then keeps its folders in ~/.config/herdr-space-folders.json on the
# machine the spaces run on: the same file Studio's Spaces sidebar reads and
# writes, so both show the same folders.
#
# Usage: install-herdr-app-layout.sh [--from DIR] [--switch] [--dry-run]
# Environment: HERDR_APP_CONFIG (default ~/.config/herdr-app),
#              HERDR_SPACE_FOLDERS_DIR (default ~/.local/share/herdr-space-folders),
#              HERDR_SPACE_FOLDERS_REPO (default the GitHub repository above).
set -euo pipefail

REPO="${HERDR_SPACE_FOLDERS_REPO:-https://github.com/jankeesvw/herdr-space-folders.git}"
CONFIG="${HERDR_APP_CONFIG:-$HOME/.config/herdr-app}"
SRC="${HERDR_SPACE_FOLDERS_DIR:-$HOME/.local/share/herdr-space-folders}"
SWITCH=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from) SRC="$2"; FROM=1; shift 2 ;;
    --switch) SWITCH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-herdr-app-layout: unknown option $1" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi
}

# 1. The mod's source.
if [ -n "${FROM:-}" ]; then
  [ -d "$SRC/mods/space-folders" ] || { echo "install-herdr-app-layout: $SRC has no mods/space-folders" >&2; exit 1; }
elif [ -d "$SRC/.git" ]; then
  echo "Updating $SRC"
  run git -C "$SRC" pull --ff-only --quiet || echo "  (could not update; using what is there)"
elif [ -e "$SRC" ]; then
  [ -d "$SRC/mods/space-folders" ] || { echo "install-herdr-app-layout: $SRC exists but is not herdr-space-folders" >&2; exit 1; }
else
  echo "Cloning herdr-space-folders into $SRC"
  run mkdir -p "$(dirname "$SRC")"
  run git clone --quiet --depth 1 "$REPO" "$SRC"
fi
SRC="$(cd "$SRC" 2>/dev/null && pwd || echo "$SRC")"

# 2. The mod (a link: `git pull` there updates it; restart Herdr App to load a new version).
run mkdir -p "$CONFIG/mods" "$CONFIG/layouts"
MOD="$CONFIG/mods/space-folders"
if [ -L "$MOD" ] && [ "$(readlink "$MOD")" = "$SRC/mods/space-folders" ]; then
  echo "Mod already linked: $MOD"
else
  if [ -e "$MOD" ] && [ ! -L "$MOD" ]; then
    echo "install-herdr-app-layout: $MOD exists and is not a link; move it away first" >&2
    exit 1
  fi
  run ln -sfn "$SRC/mods/space-folders" "$MOD"
  echo "Linked $MOD -> $SRC/mods/space-folders"
fi

# 3. The layout.
run cp "$SRC/layouts/main-folders.json" "$CONFIG/layouts/main-folders.json"
echo "Copied layout to $CONFIG/layouts/main-folders.json"

# 4. The keys: add the layout's section, keeping what is there.
KEYS="$CONFIG/keys.json"
if [ "$DRY" = 1 ]; then
  echo "would merge layout:main-folders of $SRC/keys.json into $KEYS"
else
  node - "$SRC/keys.json" "$KEYS" <<'NODE'
const fs = require('fs')
const [source, target] = process.argv.slice(2)
const ours = JSON.parse(fs.readFileSync(source, 'utf8'))['layout:main-folders'] || {}
let theirs = {}
let before = null
if (fs.existsSync(target)) {
  before = fs.readFileSync(target, 'utf8')
  try { theirs = before.trim() ? JSON.parse(before) : {} } catch (error) {
    console.error(`install-herdr-app-layout: ${target} is not plain JSON (${error.message}); add the layout:main-folders section of ${source} yourself`)
    process.exit(1)
  }
}
const section = { ...ours, ...(theirs['layout:main-folders'] || {}) }
const next = { ...theirs, 'layout:main-folders': section }
const text = `${JSON.stringify(next, null, 2)}\n`
if (before === text) { console.log(`Keys already set in ${target}`); process.exit(0) }
if (before !== null) fs.writeFileSync(`${target}.bak`, before)
fs.writeFileSync(target, text)
console.log(`Merged ${Object.keys(ours).length} keys into ${target}${before !== null ? ` (old file: ${target}.bak)` : ''}`)
NODE
fi

# 5. Switch a running Herdr App to the layout.
if [ "$SWITCH" = 1 ]; then
  if command -v herdr-app >/dev/null 2>&1; then
    run herdr-app do layout.switch --name main-folders || echo "  (Herdr App did not switch; pick main-folders with ctrl-shift-l)"
  else
    echo "herdr-app is not on PATH: pick main-folders in Herdr App with ctrl-shift-l"
  fi
else
  echo "Done. In Herdr App: herdr-app do layout.switch --name main-folders (or ctrl-shift-l)."
fi
echo "Folders are shared with Studio through ~/.config/herdr-space-folders.json on the machine your spaces run on."
