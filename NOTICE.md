# Third-party notices

## Spine Runtimes

**The published package links nothing from Esoteric Software.** An install of
`@rig-c/play` (or of `rig-play` or `spine-html`, the same files under the names the
package shipped as before) carries one JavaScript module, `dist/index.js`, plus type
declarations, and that module bundles two things: the renderer, and
`rig-c/core` (MIT), rigc's own posing core, which poses the compiled model
document `rigc build` writes. No part of the
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) is in it,
imported by it, or required beside it.

**This repository links no Spine runtime either**, since #63.
`@esotericsoftware/spine-core` and `@esotericsoftware/spine-webgl` are not
dependencies of any kind — not `dependencies`, not `peerDependencies`, not
`devDependencies` — and no lockfile entry names them. The test suite and the
benchmark compare the package's two render modes with each other; the poses
are rig-c's, held to the Spine runtime by rig-c's own CI, not here.
`tests/package.spec.ts` asserts all of that, and that nothing the published
package contains names an `@esotericsoftware/` package.

One thing in this repository is Spine data, and it is worth stating where it
sits. `rigc build`, which `scripts/fetch-assets.sh` runs to make the fixtures,
writes **Spine skeleton data** (`skeleton.json` and `skeleton.atlas`) beside
each model document, into the gitignored `public/rigs/`. Nothing here reads
it, and it is neither committed nor published.

### What that means, as a chain of facts

@rig-c/play's own code is MIT (see `LICENSE`). The following is a restatement of
Esoteric Software's terms, not a licence term of this project:

1. rigc writes two things side by side: the model document this package plays,
   and Spine skeleton data.
2. A product that plays that Spine data with **a Spine Runtime** has integrated
   the Spine Runtimes, licensed under the
   [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license).
3. That licence permits integration **under the terms and conditions of
   Section 2 of the
   [Spine Editor License Agreement](https://esotericsoftware.com/spine-editor-license)**,
   or otherwise **provided that each user of the Products obtains their own
   Spine Editor license** and any redistribution of the Products includes the
   licence and copyright notice — the two routes, in its words.
4. Playing the model document with this package integrates no Spine runtime,
   because the package links none.

> **What a consumer does with rigc's Spine-format output is governed by
> Esoteric Software's terms**, not by this package — @rig-c/play neither adds those
> terms nor removes them.

## Example assets

None are fetched or redistributed. The rigs the demo, the tests and the benchmark
read are rigc's gallery rigs — rigc's own procedural art, built from a pinned rigc
tag by `scripts/fetch-assets.sh` — and this repository's test rigs under
`tests/rigs/`, whose parts `tests/rigs/make_parts.ts` paints.
