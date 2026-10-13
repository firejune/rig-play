#!/usr/bin/env bash
# Builds every rig the demo, the test suite and the benchmark read, with the
# pinned rig-c devDependency's `rigc build`. Two sources, nothing fetched that
# is licence-bound:
#
# - rigc's gallery rigs, from the rigc tag below (each one's art is rigc's own
#   procedural drawing — its make_parts.ts);
# - this repository's test rigs, `tests/rigs/<name>/` (rig.json, motion.json
#   and parts painted by tests/rigs/make_parts.ts), which carry what no gallery
#   rig does and the renderer specs need: a clipping attachment, additive
#   slots, a region turned on its page (CLAUDE.md, *Testing*).
#
# Each build lands in `public/rigs/<name>/` with everything side by side:
# `skeleton.model.json` (what the player loads), the Spine pair `rigc build`
# writes beside it (`skeleton.json` + `skeleton.atlas`; nothing here reads
# them) and the pages, whose paths the build writes relative to that directory.
set -euo pipefail

# --- the rigc gallery builds -------------------------------------------------
#
# Every rig is built twice: as the gallery ships it, one page per part
# (`<name>/`), and with `--pack`, every part on shared pages (`<name>-packed/`).
# The second is what makes region cuts mint blobs and puts page UVs that are
# not the identity in front of the mesh tier.
#
# Pinned twice, on purpose: the sources come from the rigc tag below and the
# build is run by the rig-c devDependency of the same version, so a fixture is
# a function of one version and is rebuilt when it moves.
RIGC_TAG="v2.39.0"
RIGS="walk flex squash portrait nod look ride"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIGS_DEST="$ROOT/public/rigs"
RIGS_STAMP="$RIGS_DEST/.rigc"
RIGC="$ROOT/node_modules/.bin/rigc"

if [ -d "$RIGS_DEST" ] && [ "$(cat "$RIGS_STAMP" 2>/dev/null || true)" != "$RIGC_TAG" ]; then
  echo "rigc gallery $(cat "$RIGS_STAMP" 2>/dev/null || echo unstamped) → $RIGC_TAG, rebuilding"
  rm -rf "$RIGS_DEST"
fi

require_rigc() {
  if [ ! -x "$RIGC" ]; then
    echo "rig-c is not installed (node_modules/.bin/rigc) — run bun install first" >&2
    exit 1
  fi
}

# build <source dir> <out dir> [rigc build flags…] — built in place, so every
# page name in the atlas and the model document is relative to the build
# directory: `parts/<file>.png` one page per part, the packed pages' own names
# under --pack, the hand-packed page's under --atlas-in.
build() {
  local src="$1" out="$2"
  shift 2
  rm -rf "$out"
  mkdir -p "$out"
  cp "$src/rig.json" "$src/motion.json" "$out/"
  for dir in parts art; do
    if [ -d "$src/$dir" ]; then cp -R "$src/$dir" "$out/$dir"; fi
  done
  if ! (cd "$out" && "$RIGC" build --rig rig.json --motion motion.json --out . "$@" > build.log 2>&1); then
    cat "$out/build.log" >&2
    exit 1
  fi
  rm -f "$out/rig.json" "$out/motion.json" "$out/build.log"
}

have() {
  [ -s "$1/skeleton.model.json" ] && [ -s "$1/skeleton.json" ] && [ -s "$1/skeleton.atlas" ]
}

BUILDS=""
for rig in $RIGS; do BUILDS="$BUILDS $rig $rig-packed"; done

MISSING=""
for rig in $BUILDS; do
  if have "$RIGS_DEST/$rig"; then
    echo "have rig $rig"
  else
    MISSING="$MISSING $rig"
  fi
done

if [ -n "$MISSING" ]; then
  require_rigc
  mkdir -p "$RIGS_DEST"
  printf '%s' "$RIGC_TAG" > "$RIGS_STAMP"
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  echo "fetching rigc $RIGC_TAG gallery"
  curl -fsSL "https://codeload.github.com/rig-c/core/tar.gz/refs/tags/$RIGC_TAG" \
    | tar -xz -C "$SRC" --strip-components=1 "core-${RIGC_TAG#v}/gallery"
  for name in $MISSING; do
    rig="${name%-packed}"
    echo "building rig $name"
    if [ "$rig" != "$name" ]; then
      build "$SRC/gallery/$rig" "$RIGS_DEST/$name" --pack
      # A packed build draws from its own pages; the loose parts are not its.
      rm -rf "$RIGS_DEST/$name/parts"
    else
      build "$SRC/gallery/$rig" "$RIGS_DEST/$name"
    fi
  done
fi
echo "rigs ready (rigc $RIGC_TAG) → $RIGS_DEST"

# --- the test rigs -----------------------------------------------------------
#
# `figure` and `glow` are built like the gallery, one page per part and
# `--pack`; `duo` (two-colour tint) one page per part only; `turned` is built against its hand-packed page (`--atlas-in`),
# because rigc's own packer never turns a region and the turned region is the
# point of it. Each build is stamped with the rigc tag and a digest of its
# sources, so editing a rig — or moving the pin — rebuilds it and nothing else.
TEST_RIGS_SRC="$ROOT/tests/rigs"
mkdir -p "$RIGS_DEST"

digest() {
  (cd "$1" && find . -type f ! -name '*.md' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
}

test_rig() {
  local rig="$1" name="$2"
  shift 2
  local out="$RIGS_DEST/$name"
  local stamp
  stamp="$RIGC_TAG $(digest "$TEST_RIGS_SRC/$rig")"
  if have "$out" && [ "$(cat "$out/.source" 2>/dev/null || true)" = "$stamp" ]; then
    echo "have test rig $name"
    return
  fi
  require_rigc
  echo "building test rig $name"
  build "$TEST_RIGS_SRC/$rig" "$out" "$@"
  printf '%s' "$stamp" > "$out/.source"
}

test_rig figure figure
test_rig figure figure-packed --pack
rm -rf "$RIGS_DEST/figure-packed/parts"
test_rig glow glow
test_rig glow glow-packed --pack
rm -rf "$RIGS_DEST/glow-packed/parts"
test_rig turned turned --atlas-in art/turned.atlas
rm -f "$RIGS_DEST/turned/art/turned.atlas"
test_rig duo duo
echo "test rigs ready → $RIGS_DEST"
