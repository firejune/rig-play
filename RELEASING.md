# Releasing

The cut is one click: merge the release pull request. Everything either side of
that click is `.github/workflows/release.yml`, and no npm credential exists on
any machine — the publish authenticates to the registry over OIDC (npm trusted
publishing), so there is no token to leak and no 2FA prompt to answer.

## The loop

Every push to `main` runs `release.yml`, which hands the new commits to
[release-please](https://github.com/googleapis/release-please-action):

- **Nothing releasable since the last tag** → the run does nothing. Commit
  types release-please hides from the changelog (`docs`, `test`, `ci`, `build`,
  `chore`, `refactor`, `style`) do not open a release pull request on their own.
- **Something releasable** → it opens, or updates, a pull request titled
  `release: vX.Y.Z` containing exactly three generated changes: the
  `package.json` version, `CHANGELOG.md`, and `.release-please-manifest.json`.
  `feat` bumps the minor, `fix` and `perf` bump the patch. A `!` or a
  `BREAKING CHANGE:` footer bumps the **minor** while the package is pre-1.0
  (`bump-minor-pre-major`) — 1.0.0 is a deliberate act, not the side effect of
  one commit. To force a version, put `Release-As: 1.0.0` in a commit footer.
- **That pull request is merged** → the merge is a push to `main`, so
  `release.yml` runs again; this time release-please tags `vX.Y.Z`, creates the
  GitHub release, and the same run publishes the package — under both of its
  names (*Two names, one tarball*, below).

Squash-merge the release pull request, so the commit on `main` keeps the
`release: vX.Y.Z` subject this repository has used since v0.2.0.

## Three names, one tarball

The package is **`@rig-c/play`**, the `name` in `package.json`, from the move to
the `rig-c` organisation (#98). Versions 1.0 to 1.8 shipped as **`rig-play`** and
every version up to 0.8.0 as **`spine-html`**; both names stay published as
**aliases** (#65, #98): every cut publishes all three from one run, with the same
files, because links outside this repository — the npm pages, forum threads,
articles, badges other READMEs copied — point at the earlier names, and nothing
but an alias keeps its npm page current. GitHub redirects the old repository
URLs (`firejune/spine-html`, `firejune/rig-play`); nothing redirects an npm page.

- **One tarball's files.** After `npm publish --access public` has published
  `@rig-c/play` from the checkout — gated by `prepublishOnly`, which builds
  `dist/` from the tagged tree; a scoped package is restricted unless told
  otherwise — the next step runs, once per alias, `node scripts/alias-tarball.mjs
  pack --alias <name> --out "$RUNNER_TEMP/alias-<name>"`: it packs the same
  checkout with scripts ignored (the `dist/` that was just published), extracts
  the tarball into the runner's temp directory, rewrites the one `"name"` line
  of the extracted `package.json` to the alias, packs that again, and prints the
  path only after reading the two tarballs as the same files. `npm publish <that
  tarball> --access public --ignore-scripts` publishes it with provenance. The
  checkout is never modified. The aliases the script accepts are listed once, in
  `ALIASES` at the top of the script.
- **The comparison.** The two tarballs never share a `dist.shasum` — one line of
  one file differs by design, and the tar and gzip headers with it — so "the
  same files" is read off the unpacked tarballs: the same set of paths, every
  file byte-identical, and `package/package.json` identical once the alias's
  `name` line is put back. `node scripts/alias-tarball.mjs compare <a.tgz>
  <b.tgz>` is that reading on its own; it exits 0 and prints `PASS
  ALIAS_SAME_CONTENT: spine-html carries the N file(s) of @rig-c/play, byte
  for byte but for the name line of package/package.json`, or exits 1 naming
  each path that differs. `tests/package.spec.ts` runs the pack over a temp
  build for each alias on every CI run, diffs the two manifests itself, and
  plants a one-byte difference the comparison has to name.
- **The confirmation.** The last step of the release run fetches every name at
  the released version from the registry (retrying for up to 15 minutes each
  while the registry catches up), prints `npm view` for each, and runs
  `compare` on the canonical tarball against each alias's as the registry served
  them — so what is held equal is the published bytes, not this tree's. A version not served in time is a red
  that says the confirmation was not taken; it does not un-publish anything.
- **An alias never has its own version.** No version of `rig-play` or
  `spine-html` is made by hand: it is `@rig-c/play`'s files at its version, or
  nothing. The one step that publishes aliases alone is the `alias` job of
  `release.yml`, run by hand (**Actions → release → Run workflow**, with the
  version and the aliases still missing) when a cut published `@rig-c/play` and
  an alias publish after it failed — the first `rig-play` cut, v1.0.0, did
  exactly that, on a `spine-html` trusted-publisher form that still named the
  repository's old path. The release job cannot be re-run for it (its first
  publish is then refused as an existing version before the alias step is
  reached), so that job takes the registry's own `@rig-c/play@<version>`
  tarball (`rig-c-play-<version>.tgz`), never a rebuild, rewrites the name line
  for each alias named and runs the same confirmation. No lifecycle script runs on it, by design:
  `npm publish <tarball>` runs none, and the alias is the gated publish's files,
  held to them by the comparison before its path is printed.
- **They are kept, not retired.** No `npm deprecate` — a banner on every install
  is a retirement under an alias's name. The README's first paragraph names the
  package's name, and the same file is the alias's npm page. Retiring the alias
  is a separate card, opened only after three answers are written down in it:
  what npm history is lost (download counts, the package page, the provenance
  links of every version under that name), an inventory of the external links
  and where each resolves after a retirement, and what the alias says until
  then (#65).

## One-time setup (owner, GitHub)

**Settings → Actions → General → Workflow permissions → tick "Allow GitHub
Actions to create and approve pull requests."** It is off by default, and while
it is off release-please cannot open the release pull request at all — the run
fails with *GitHub Actions is not permitted to create or approve pull
requests*. Nothing in a workflow file can grant this; it is a repository
setting.

The neighbouring "Workflow permissions" radio can stay on the read-only
default: `release.yml` declares the write scopes it needs per job, and that
elevation is granted (verified in run 32583344688 — the job received Contents,
Issues and PullRequests write under a read-only repository default).

## One-time setup (owner, npmjs.com)

Do this once per name, before the first cut that publishes it. It cannot be
done from here — it needs the account. npm keys a trusted publisher to the
package, so there is **one form per name**, and both are filled in the same way.

1. npmjs.com → **@rig-c/play** → **Settings** → **Trusted Publisher** →
   *GitHub Actions*; and again under **rig-play** and **spine-html**, whose
   existing forms named the repository by an earlier path and have to name the
   current one — the OIDC token a run presents carries the repository it ran in,
   `rig-c/play`, and a provenance statement must match `repository.url`.
2. Fill in each, exactly (the fields are case-sensitive, and npm does not
   validate them on save — a typo only surfaces as a failed publish):
   - Organization or user: `rig-c`
   - Repository: `play`
   - Workflow filename: `release.yml`
   - Environment name: *leave blank* (the workflow declares no environment; a
     value here that the workflow does not match rejects the publish)
   - Allowed actions: `npm publish`
3. After the first successful automated publish — not before — set
   **Settings → Publishing access → Require two-factor authentication and
   disallow tokens**. Trusted publishing keeps working under that setting; it
   is what closes the door behind the classic tokens. Setting it first would
   leave no way back if the OIDC path needs a fix. The setting is per package:
   each name gets it once that name has published from the workflow.

Until `@rig-c/play`'s form exists, the first publish of a cut is refused on
authentication and the alias steps after it never run, so a cut waits for that
form rather than going out under fewer names. npmjs.com offers no settings page
for a package that does not exist yet, so a renamed package's first version goes
up by hand — measured twice: `rig-c`'s (rigc RELEASING.md, *The package name is
`rig-c`*) and `rig-play`'s on 2026-10-11, each from the previous name's registry
tarball with the `name` line changed and nothing else, published with
`--ignore-scripts`. A scoped name also needs its npm organisation (`rig-c`) and
`--access public`. `node scripts/alias-tarball.mjs compare` reads such a pair the
same way.

The repository setting above (*Allow GitHub Actions to create and approve pull
requests*) is per repository and does not travel with a transfer: after the move
to `rig-c/play` it has to be ticked again, or release-please cannot open its pull
request.

Two properties of that configuration are load-bearing in the workflow:

- Every publish step must live in **`release.yml`**. Renaming the file, or
  moving any publish into another workflow, breaks that name's trusted
  publisher until its form is updated to match.
- It must run on a **GitHub-hosted runner**. npm does not support trusted
  publishing from self-hosted runners, so this job never moves to a private
  machine.

## Cutting a release

0. Once, before the first cut: both setup sections above, with one trusted
   publisher form per name.
1. Land the work on `main` as usual, with conventional-commit subjects. CI runs
   on every push.
2. Wait for the `release` run to open or update the `release: vX.Y.Z` pull
   request.
3. Read the diff — the version and the generated changelog are the whole review.
   Run the suite against the release branch — read the branch name off the
   pull request, it carries the package name
   (it was `release-please--branches--main--components--rig-play` until 1.8;
   read the scoped name's off the first release pull request): **Actions → ci →
   Run workflow**, or `gh workflow run ci.yml --ref <that branch>` (see below
   for why it is not automatic). The release needs it green. A skip in its log
   is not expected and should be read.
4. **Merge it.** That is the cut.
5. Watch the second `release` run: it tags, releases, publishes `@rig-c/play`,
   publishes the two aliases, and confirms every name serves the same files —
   its last step prints one comparison line per alias.
6. Confirm: `npm view @rig-c/play version`, `npm view rig-play version` and
   `npm view spine-html version` print the same version, and each npm page shows
   a provenance attestation of the same workflow run.

## Why the release pull request shows no CI check

A pull request opened with the default `GITHUB_TOKEN` does not get an ordinary
workflow run. What actually happens — observed on the first release pull
request this automation opened (#17) — is that `ci` **is created** on every
update of the release branch and then held at once with the conclusion
`action_required`, waiting for a maintainer to approve it. Nothing runs, `gh pr
checks` reports "no checks", and the pull request reads as `UNSTABLE` rather
than clean. "Absent" and "held" call for different actions, so it is worth being
exact: there are two ways to get a green on the release commit itself —

- dispatch `ci` on the release branch (**Actions → ci → Run workflow**, or
  `gh workflow run ci.yml --ref <release branch>`), which is what v0.5.0 did
  (84 passed on the release commit before the merge); or
- approve the held run (`gh api -X POST
  repos/rig-c/play/actions/runs/<id>/approve`).

The usual way to make the check automatic is a personal access token or a
GitHub App, and this repository deliberately does not use one:

- The base of the release pull request is a commit on `main` that `ci.yml`
  already tested on push.
- The pull request adds only generated version and changelog text. There is no
  source change for a test run to have an opinion about.
- A personal access token with `contents: write` and `pull-requests: write`
  would be the only long-lived credential in the repository — reintroducing the
  class of secret trusted publishing was adopted to remove.
- The publish is not unguarded regardless: `prepublishOnly` runs
  `tsc -p tsconfig.build.json` against the tagged tree, so a type error fails
  the publish rather than shipping.

If a rendered check on the pull request is ever wanted anyway, it takes no edit
to `release.yml`: create a fine-grained personal access token scoped to the
`rig-c/play` repository with **Contents: read and write** and **Pull
requests: read and write**, store it as the repository secret
`RELEASE_PLEASE_TOKEN`, and the workflow picks it up
(`secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN`). The cost is a
credential to rotate.

## What was pre-flighted, and what the first cut proved

A throwaway branch (run 32583528151) exercised everything in the publish path
that does not touch the registry: `id-token: write` mints an OIDC token with
`aud: npm:registry.npmjs.org` and a `workflow_ref` claim naming the workflow
file — which is the claim npm matches against the trusted publisher, so the
filename in the form and the filename in `.github/workflows/` must agree.
`npm install -g npm@latest` produced npm 12, well past the 11.5.1 that speaks
OIDC. `bun install --frozen-lockfile` plus `prepublishOnly` built the tarball
on the runner: 28 files, `dist/` included by the `files` allowlist even though
git ignores it.

One log detail that looks alarming and is not: the `GITHUB_TOKEN Permissions`
group printed at the start of a job never lists `IdToken`, whether or not the
job requested it. The probe requested `id-token: write`, the group showed only
`Contents: read` / `Metadata: read`, and the token minted anyway.

The registry side of the exchange could only be proven by a real cut, because it
needs the trusted publisher to exist — and **v0.5.0 (2026-09-18) proved it**: the
release pull request was merged, the same `release` run tagged, released and
published in one pass, and the registry serves the tarball with a SLSA
provenance attestation. What follows is kept for the day it breaks: if a publish
fails on authentication rather than
on a publisher mismatch, the first thing to try is dropping `registry-url` from
the `setup-node` step: it exists only to write an `.npmrc`, and the `.npmrc` it
writes carries a `NODE_AUTH_TOKEN` placeholder that nothing sets.

## If the automation is unavailable

The old path still works and needs nothing from this workflow: `npm version
<patch|minor|major>`, push the commit and the tag, `npm publish`. It publishes
with a classic token and a 2FA one-time password — which is why it stops being
available the moment "require two-factor authentication and disallow tokens" is
switched on. Fix the workflow instead.
