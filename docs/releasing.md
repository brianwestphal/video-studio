# Releasing video-studio

Releases are **tag-driven**: `scripts/release.sh` validates locally, bumps the
version, writes the CHANGELOG, and pushes a git tag. GitHub Actions
(`.github/workflows/release.yml`) does the rest — it re-runs the checks, creates
a GitHub Release, and publishes to npm with provenance.

## Stable release

```bash
npm run release
```

This walks you through (resumable via `.release-state.json` if interrupted):

1. **Pre-flight** — clean tree check, npm login status, branch check.
2. **Release notes** — drafted by [gitgist](https://github.com/brianwestphal/gitgist)
   from the commits since the last tag (needs the `claude` CLI signed in), then
   opened in your `$EDITOR` to edit. Falls back to manual entry.
3. **Version bump** — pick patch / minor / major / custom.
4. **Review** — confirm version + notes.
5. **Apply** — `npm version` (no tag), prepend the CHANGELOG entry.
6. **Local checks** — `lint → typecheck → test → build`.
7. **Commit, tag, push** — `release: v{ver}` commit + annotated `v{ver}` tag.

CI then publishes the tag to **`npm install video-studio`** (the `latest` tag)
and creates the GitHub Release from the matching CHANGELOG section.

## Beta release

```bash
npm run release:beta
```

Tag-only — it does **not** bump `package.json` or touch the CHANGELOG. It runs
the local checks and pushes a `v{ver}-beta.{N}` tag off HEAD (auto-incrementing
`N`). CI publishes it under the **`beta`** dist-tag and flags the GitHub Release
as a prerelease. Users get it with `npm install video-studio@beta`. There is no
auto-promote to stable.

## Commit messages

```bash
npm run commit:msg
```

Drafts a commit message for the currently-staged changes with gitgist.

## One-time setup: npm trusted publishing (OIDC)

The release workflow publishes **without an `NPM_TOKEN`** — it uses npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers) via GitHub OIDC.
Before the first CI publish can succeed, configure it once:

1. On npmjs.com, open the **`video-studio`** package → **Settings** →
   **Trusted Publishers** (the package must already exist — it was first
   published manually).
2. Add a **GitHub Actions** publisher:
   - **Organization / user**: `brianwestphal`
   - **Repository**: `video-studio`
   - **Workflow filename**: `release.yml`
   - **Environment**: `npm-publish`
3. In the GitHub repo, create an **Environment** named **`npm-publish`**
   (Settings → Environments). The `npm-publish` job runs in it. Add protection
   rules (e.g. required reviewers) if you want a manual gate before publish.

The workflow already requests `id-token: write` and upgrades to a recent npm, so
once the publisher is registered, `npm publish --provenance` authenticates with
no secrets.

## If something goes wrong

- **A check fails locally** — fix it; re-run `npm run release` and it resumes
  from the saved step.
- **CI fails after the tag is pushed** — fix forward, then either re-run the
  failed workflow or delete and re-push the tag.
- **Stuck release state** — delete `.release-state.json` to start clean.
