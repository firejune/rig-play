// The package under its second name: the same bytes as the tarball this tree
// packs, with the `name` line of `package.json` changed and nothing else.
//
//     node scripts/alias-tarball.mjs pack --alias <name> --out <dir> [--dir <package dir> | --tarball <tgz>]
//     node scripts/alias-tarball.mjs compare <package.tgz> <alias.tgz>
//
// The package is published as `@rig-c/play`, the `name` in package.json, and at
// every version again under the two names it shipped under before (#65, #98):
// `rig-play` (1.0–1.8) and `spine-html` (0.x). Links outside this repository
// point at both, and nothing but an alias keeps an npm page current.
// RELEASING.md *Three names, one tarball* says which name is which.
//
// `pack` writes the alias tarball into `--out` and prints its path as the last
// line of stdout, which is what `release.yml` hands to its second
// `npm publish`. It packs `--dir` (this checkout by default, with
// `--ignore-scripts`: the `dist/` the gated publish built is what it packs) or
// takes `--tarball`, extracts the result, rewrites the one top-level
// `"name": …` line of the extracted `package.json`, packs the extraction
// again, and prints a path only when `compare` then reads the two tarballs as
// identical but for that line. Nothing is written inside the package
// directory, so the tree the publish read is the tree the alias is made from.
//
// `compare` is the same reading on its own, for any two tarballs: the same set
// of paths, every file byte-identical, and `package/package.json` identical
// once the alias's `name` line is put back to the package's. The release's
// confirmation step runs it on the two tarballs the registry served.
//
// Not the tarballs' hashes: one line of one file differs by design, and the
// gzip and tar headers differ with it. What is promised is the unpacked
// content, so that is compared, file by file, and a difference is named by
// path, both sizes and the first byte at which they part.
//
// The alias publish runs no lifecycle script, and that is the design rather
// than a gap: `npm publish <tarball>` runs none, so `prepublishOnly` (the
// typecheck and the library build) gates the first publish and only that one.
// The alias carries that publish's files, held to them here before its path is
// printed.
//
// Exit codes: 0 the alias was written (`pack`) or the two tarballs carry the
// same content but for the name (`compare`); 1 they do not, each difference
// named; 2 a usage error, or a pack or an extraction that did not complete,
// so nothing was measured.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The earlier names. Not in package.json, which names the package once; this
 * is the one place in the tree a program reads them from.
 */
export const ALIASES = ['rig-play', 'spine-html'];

const EXIT_SAME = 0;
const EXIT_DIFFERENT = 1;
const EXIT_USAGE = 2;

/** The file whose `name` line is the one permitted difference. */
const MANIFEST = 'package/package.json';

/** A step that did not complete, so there is no reading to report. Exit 2. */
export class AliasTarballError extends Error {}

/** An alias that was packed and reads as different from its package beyond the name. Exit 1. */
export class AliasDiffersError extends AliasTarballError {}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const failed = r.error === undefined ? '' : `\n${r.error.message}`;
  return { status: typeof r.status === 'number' ? r.status : 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${failed}` };
}

/** Every file under a directory, by its path relative to it, sorted so two listings compare line for line. */
function filesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function extract(tgz, into) {
  mkdirSync(into, { recursive: true });
  const unpacked = run('tar', ['-xzf', tgz, '-C', into], into);
  if (unpacked.status !== 0) throw new AliasTarballError(`\`tar -xzf ${tgz}\` exited ${unpacked.status}: ${unpacked.out.trim().slice(0, 2000)}`);
  if (!existsSync(join(into, MANIFEST))) throw new AliasTarballError(`${tgz} holds no ${MANIFEST}, so it is not an npm package tarball`);
}

/** The `name` a package.json declares, read as JSON rather than as text. */
function nameIn(manifestText, where) {
  const parsed = JSON.parse(manifestText);
  if (typeof parsed.name !== 'string' || parsed.name === '') throw new AliasTarballError(`${where} declares no name`);
  return parsed.name;
}

/** The manifest's text with its one `"name": "<from>"` line rewritten to `<to>`, or null if there is not exactly one. */
function renamed(text, from, to) {
  const escaped = JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^(\\s*"name"\\s*:\\s*)${escaped}(\\s*,?\\s*)$`, 'gm');
  const hits = [...text.matchAll(line)];
  if (hits.length !== 1) return null;
  return text.replace(line, (_all, head, tail) => `${head}${JSON.stringify(to)}${tail}`);
}

/** Where two byte strings first part, or -1 when one is the other. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Hold `aliasTgz` to `packageTgz`: the same paths, every file the same bytes,
 * and the manifest the same text once the alias's `name` line reads the
 * package's name. Throws `AliasTarballError` only when a tarball cannot be
 * read at all; every difference between two readable tarballs is a fault.
 *
 * @returns {{ name: string, alias: string, files: number, faults: string[] }}
 */
export function compareTarballs(packageTgz, aliasTgz) {
  const work = mkdtempSync(join(tmpdir(), 'play-alias-compare-'));
  try {
    const a = join(work, 'package');
    const b = join(work, 'alias');
    extract(packageTgz, a);
    extract(aliasTgz, b);
    const aText = readFileSync(join(a, MANIFEST), 'utf8');
    const bText = readFileSync(join(b, MANIFEST), 'utf8');
    const name = nameIn(aText, `${packageTgz}'s ${MANIFEST}`);
    const alias = nameIn(bText, `${aliasTgz}'s ${MANIFEST}`);
    const faults = [];
    const left = filesUnder(a);
    const right = filesUnder(b);
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    for (const path of left) if (!rightSet.has(path)) faults.push(`${path} is in ${name}'s tarball and not in ${alias}'s`);
    for (const path of right) if (!leftSet.has(path)) faults.push(`${path} is in ${alias}'s tarball and not in ${name}'s`);
    if (alias === name) faults.push(`${MANIFEST} names ${JSON.stringify(alias)}, the package's own name, so the second tarball is not under another name`);
    for (const path of left) {
      if (!rightSet.has(path)) continue;
      let mine = readFileSync(join(a, path));
      let theirs = readFileSync(join(b, path));
      if (path === MANIFEST && alias !== name) {
        const back = renamed(bText, alias, name);
        if (back === null) {
          faults.push(`${MANIFEST} of ${alias} does not carry exactly one "name": ${JSON.stringify(alias)} line, so its one permitted difference cannot be read as the only one`);
          continue;
        }
        mine = Buffer.from(aText, 'utf8');
        theirs = Buffer.from(back, 'utf8');
      }
      const at = firstDifference(mine, theirs);
      if (at !== -1) {
        faults.push(
          `${path} differs${path === MANIFEST ? ' beyond its name line' : ''}: ${mine.length} byte(s) in ${name}'s tarball and ${theirs.length} in ${alias}'s, first parting at byte ${at}`,
        );
      }
    }
    return { name, alias, files: left.length, faults };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `npm pack` of a directory into an empty one, returning the one tarball it wrote. */
function packInto(dir, into) {
  mkdirSync(into, { recursive: true });
  const before = new Set(readdirSync(into));
  const packed = run('npm', ['pack', dir, '--ignore-scripts', '--pack-destination', into, '--loglevel=error'], into);
  const made = readdirSync(into).filter((f) => f.endsWith('.tgz') && !before.has(f));
  if (packed.status !== 0 || made.length !== 1) {
    throw new AliasTarballError(`\`npm pack ${dir}\` exited ${packed.status} and left ${made.length} new tarball(s); one was required. ${packed.out.trim().slice(0, 2000)}`);
  }
  return join(into, made[0]);
}

/**
 * Write the alias tarball into `out` and return its path, after holding it to
 * the package tarball it was made from. That tarball is packed from `dir`
 * unless `packageTgz` is given.
 */
export function packAlias({ out, dir = ROOT, packageTgz, alias }) {
  if (!ALIASES.includes(alias)) throw new AliasTarballError(`${JSON.stringify(alias)} is not one of the package's earlier names (${ALIASES.join(', ')})`);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'play-alias-pack-'));
  try {
    const primary = packageTgz ?? packInto(dir, join(work, 'package'));
    const tree = join(work, 'tree');
    extract(primary, tree);
    const manifest = join(tree, MANIFEST);
    const text = readFileSync(manifest, 'utf8');
    const name = nameIn(text, `${primary}'s ${MANIFEST}`);
    if (alias === name) throw new AliasTarballError(`${alias} is the package's own name, so there is no alias to make`);
    const next = renamed(text, name, alias);
    if (next === null) throw new AliasTarballError(`${primary}'s ${MANIFEST} does not carry exactly one "name": ${JSON.stringify(name)} line, so there is no one line to change`);
    writeFileSync(manifest, next);
    const tgz = packInto(join(tree, 'package'), out);
    const comparison = compareTarballs(primary, tgz);
    if (comparison.faults.length > 0) {
      rmSync(tgz, { force: true });
      throw new AliasDiffersError(`the alias packed from ${primary} differs from it beyond the name:\n  ${comparison.faults.join('\n  ')}`);
    }
    return { tgz, comparison };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The one line both commands print on success: what the release log and the spec read. */
export function sameContentLine(comparison) {
  return `PASS  ALIAS_SAME_CONTENT: ${comparison.alias} carries the ${comparison.files} file(s) of ${comparison.name}, byte for byte but for the name line of ${MANIFEST}`;
}

const HELP = `@rig-c/play alias tarball — the package under an earlier name (${ALIASES.join(' or ')}), with nothing else changed

usage:
  node scripts/alias-tarball.mjs pack --alias <name> --out <dir> [--dir <package dir> | --tarball <tgz>]
  node scripts/alias-tarball.mjs compare <package.tgz> <alias.tgz>

pack     packs <package dir> (default: this checkout, scripts ignored) or takes
         --tarball, rewrites the one "name" line of its package.json to <name>,
         packs it again into <dir>, holds the result to the package tarball with
         compare, and prints the alias tarball's path last
compare  the same paths, every file the same bytes, and package.json the same once
         the alias's name line reads the package's name

exit codes:
  0  the alias was written, or the two carry the same content but for the name
  1  they do not — each difference is named
  2  a usage error, or a pack or an extraction did not complete
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return argv.length === 0 ? EXIT_USAGE : EXIT_SAME;
  }
  const [command, ...rest] = argv;
  try {
    if (command === 'compare') {
      if (rest.length !== 2 || rest.some((path) => !existsSync(path))) {
        console.error('alias-tarball: compare takes two tarballs that exist; --help shows the form');
        return EXIT_USAGE;
      }
      const reading = compareTarballs(resolve(rest[0]), resolve(rest[1]));
      if (reading.faults.length > 0) {
        console.log(`FAIL  ALIAS_SAME_CONTENT: ${reading.alias} differs from ${reading.name} beyond its name:`);
        for (const fault of reading.faults) console.log(`        ${fault}`);
        return EXIT_DIFFERENT;
      }
      console.log(sameContentLine(reading));
      return EXIT_SAME;
    }
    if (command === 'pack') {
      const flags = new Map();
      for (let i = 0; i < rest.length; i += 2) {
        const [flag, value] = [rest[i], rest[i + 1]];
        if (!['--alias', '--out', '--dir', '--tarball'].includes(flag) || value === undefined || value.startsWith('--')) {
          console.error(`alias-tarball: "${flag}" is not an argument pack takes with a value; --help lists them`);
          return EXIT_USAGE;
        }
        flags.set(flag, value);
      }
      const out = flags.get('--out');
      const alias = flags.get('--alias');
      const dir = flags.get('--dir');
      const tarball = flags.get('--tarball');
      if (out === undefined) {
        console.error('alias-tarball: pack needs --out <dir>');
        return EXIT_USAGE;
      }
      if (alias === undefined || !ALIASES.includes(alias)) {
        console.error(`alias-tarball: pack needs --alias, one of ${ALIASES.join(', ')}`);
        return EXIT_USAGE;
      }
      if (dir !== undefined && tarball !== undefined) {
        console.error('alias-tarball: pack takes --dir or --tarball, not both');
        return EXIT_USAGE;
      }
      if (tarball !== undefined && !existsSync(tarball)) {
        console.error(`alias-tarball: --tarball ${tarball} names no file`);
        return EXIT_USAGE;
      }
      if (dir !== undefined && !existsSync(join(dir, 'package.json'))) {
        console.error(`alias-tarball: --dir ${dir} holds no package.json`);
        return EXIT_USAGE;
      }
      const made = packAlias({
        out: resolve(out),
        dir: dir === undefined ? ROOT : resolve(dir),
        packageTgz: tarball === undefined ? undefined : resolve(tarball),
        alias,
      });
      console.error(`alias-tarball: ${sameContentLine(made.comparison)}`);
      console.log(made.tgz);
      return EXIT_SAME;
    }
    console.error(`alias-tarball: "${command}" is not a command; --help lists them`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof AliasTarballError) {
      console.error(`alias-tarball: ${error.message}`);
      return error instanceof AliasDiffersError ? EXIT_DIFFERENT : EXIT_USAGE;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
