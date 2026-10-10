# Third-party notices

## Spine Runtimes

Neither this package nor this repository depends on the
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) any more.
`@esotericsoftware/spine-core` and `@esotericsoftware/spine-webgl` are not
dependencies of any kind — not `dependencies`, not `peerDependencies`, not
`devDependencies` — and no lockfile entry names them: the player poses rigs built
by rigc through `rig-c/core` (MIT), which the build bundles into the package, and
the test suite and the benchmark compare the package's two render modes with each
other. `tests/package.spec.ts` asserts all of that, and that nothing the published
package contains names an `@esotericsoftware/` package.

## Example assets

None are fetched or redistributed. The rigs the demo, the tests and the benchmark
read are rigc's gallery rigs — rigc's own procedural art, built from a pinned rigc
tag by `scripts/fetch-assets.sh` — and this repository's test rigs under
`tests/rigs/`, whose parts `tests/rigs/make_parts.ts` paints.
