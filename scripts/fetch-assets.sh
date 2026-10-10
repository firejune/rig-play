#!/usr/bin/env bash
# Two halves. The first downloads the official Spine example skeleton
# (spineboy) from the spine-runtimes repository — the reference side of the
# test suite (the pixel oracle, the spineboy stage, the renderer specs). These
# assets are owned by Esoteric Software and are NOT redistributed with this
# repository — see NOTICE.md. The second builds rigc's gallery rigs (below).
#
# SPINE_ASSETS_BRANCH picks which spine-runtimes branch to take spineboy from,
# and therefore which editor version exported it. It defaults to 4.3, so a
# plain run is byte-identical to what this script always did: a runtime only
# reads data its own generation exported, so the reference side runs the 4.3
# runtime over the 4.3 exports.
#
# The files land where the demo already looks for them (`public/spineboy`),
# whichever branch they came from — nothing downstream is told which one it is.
# The switch is therefore in the checkout, not in the code: two branches' assets
# are never present at once, which is why the destination is cleared when the
# branch changes rather than merged into.
set -euo pipefail

BRANCH="${SPINE_ASSETS_BRANCH:-4.3}"
BASE="https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/${BRANCH}/examples/spineboy/export"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/spineboy"
STAMP="$DEST/.branch"

# Idempotent: already-downloaded files are kept, so this is safe to run as a
# predev/prebuild hook (a fresh clone has no assets — they are gitignored).
# A *different* branch than last time is not idempotent, though: the exports
# would be mixed generation by generation, and the one that stayed behind would
# be the one that fails to parse. So switching branches starts clean.
#
# An unstamped directory is read as 4.3, not as unknown: before this script took
# a branch it only ever fetched 4.3, so that is what a checkout from then holds.
# Reading it as unknown would instead refetch every existing checkout once, for
# files it already has and that are already right.
PREVIOUS=4.3
if [ -f "$STAMP" ]; then PREVIOUS="$(cat "$STAMP")"; fi
if [ -d "$DEST" ] && [ "$PREVIOUS" != "$BRANCH" ]; then
  echo "assets branch $PREVIOUS → $BRANCH, refetching"
  rm -rf "$DEST"
fi

mkdir -p "$DEST"
# The stamp names the branch this directory is being filled from, so it is
# written before the downloads rather than after them: a run that dies halfway
# still leaves a directory that only ever held one branch's exports, and the
# next run resumes it instead of mixing a second branch into it.
printf '%s' "$BRANCH" > "$STAMP"

# `spineboy-pma.atlas` / `spineboy-pma.png` are the same artwork exported with
# the packer's default premultiply on: the atlas text differs from the plain one
# by the page name and a `pma: true` line, and by nothing else — same regions,
# same bounds — so the same skeleton export reads against either. That is what
# makes them the pixel oracle's premultiplied cell (tests/oracle.spec.ts): a real
# `pma` page from the exporter, not a fixture this repository paints. They are
# listed as required rather than best-effort because every branch of the CI
# matrix ships them — all seven files below were checked on 4.0, 4.1, 4.2 and
# 4.3 — so a 404 is a fact worth a loud failure and not something to render
# around. If a future branch drops one, the cells that need it skip on the
# file's absence and say so; they do not key on a version.
for f in spineboy-ess.json spineboy-pro.json spineboy-pro.skel spineboy.atlas spineboy.png \
         spineboy-pma.atlas spineboy-pma.png; do
  if [ -s "$DEST/$f" ]; then
    echo "have $f"
  else
    echo "fetching $f"
    curl -fsSL "$BASE/$f" -o "$DEST/$f"
  fi
done
echo "assets ready (spine-runtimes $BRANCH) → $DEST"

# --- the rigc gallery builds -------------------------------------------------
#
# The demo, the parity and oracle cells over the model path, and the frame gate
# (tests/frames.spec.ts) read rigc's own example rigs, built by `rigc build`.
# The rigs are rigc's procedural art (each one's make_parts.ts draws it), so
# nothing licence-bound is fetched for this half. Each build lands in
# `public/rigs/<name>/` with everything side by side: `skeleton.model.json`
# (what the player loads), `skeleton.json` + `skeleton.atlas` (the Spine pair
# the reference side and the frame gate load) and the pages under `parts/`,
# whose paths the build writes relative to that directory.
#
# Every rig is built twice: as the gallery ships it, one page per part
# (`<name>/`), and with `--pack`, every part on shared pages (`<name>-packed/`).
# The second is what makes region cuts mint blobs and puts page UVs that are
# not the identity in front of the mesh tier and the frame gate.
#
# Pinned twice, on purpose: the sources come from the rigc tag below and the
# build is run by the rig-c devDependency of the same version, so a fixture is
# a function of one version and is rebuilt when it moves.
RIGC_TAG="v2.35.0"
RIGS="walk flex squash portrait nod look ride"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIGS_DEST="$ROOT/public/rigs"
RIGS_STAMP="$RIGS_DEST/.rigc"

if [ -d "$RIGS_DEST" ] && [ "$(cat "$RIGS_STAMP" 2>/dev/null || true)" != "$RIGC_TAG" ]; then
  echo "rigc gallery $(cat "$RIGS_STAMP" 2>/dev/null || echo unstamped) → $RIGC_TAG, rebuilding"
  rm -rf "$RIGS_DEST"
fi

BUILDS=""
for rig in $RIGS; do BUILDS="$BUILDS $rig $rig-packed"; done

MISSING=""
for rig in $BUILDS; do
  if [ -s "$RIGS_DEST/$rig/skeleton.model.json" ] && [ -s "$RIGS_DEST/$rig/skeleton.json" ] \
     && [ -s "$RIGS_DEST/$rig/skeleton.atlas" ]; then
    echo "have rig $rig"
  else
    MISSING="$MISSING $rig"
  fi
done

if [ -n "$MISSING" ]; then
  RIGC="$ROOT/node_modules/.bin/rigc"
  if [ ! -x "$RIGC" ]; then
    echo "rig-c is not installed (node_modules/.bin/rigc) — run bun install first" >&2
    exit 1
  fi
  mkdir -p "$RIGS_DEST"
  printf '%s' "$RIGC_TAG" > "$RIGS_STAMP"
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  echo "fetching rigc $RIGC_TAG gallery"
  curl -fsSL "https://codeload.github.com/firejune/rigc/tar.gz/refs/tags/$RIGC_TAG" \
    | tar -xz -C "$SRC" --strip-components=1 "rigc-${RIGC_TAG#v}/gallery"
  for build in $MISSING; do
    rig="${build%-packed}"
    pack=""
    if [ "$rig" != "$build" ]; then pack="--pack"; fi
    echo "building rig $build"
    out="$RIGS_DEST/$build"
    rm -rf "$out"
    mkdir -p "$out"
    cp "$SRC/gallery/$rig/rig.json" "$SRC/gallery/$rig/motion.json" "$out/"
    cp -R "$SRC/gallery/$rig/parts" "$out/parts"
    # Built in place, so every page name in the atlas and the model document
    # is relative to the build directory: `parts/<file>.png` one page per
    # part, the packed pages' own names under --pack.
    if ! (cd "$out" && "$RIGC" build --rig rig.json --motion motion.json --out . $pack > build.log 2>&1); then
      cat "$out/build.log" >&2
      exit 1
    fi
    rm -f "$out/rig.json" "$out/motion.json" "$out/build.log"
    # A packed build draws from its own pages; the loose parts are not its.
    if [ -n "$pack" ]; then rm -rf "$out/parts"; fi
  done
fi
echo "rigs ready (rigc $RIGC_TAG) → $RIGS_DEST"
