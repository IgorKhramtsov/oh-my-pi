# OMP fork maintenance

This fork-only runbook intentionally lives on `feat/session-parking`, not on the upstream-mirroring `main` branch. Read it before updating or deploying the fork.

Personal OMP adds session parking and this guide as one commit on top of a stable upstream release.

```text
can1357/oh-my-pi release tag
             |
             +-- session-parking commit
                     |
                     +-- IgorKhramtsov/oh-my-pi:feat/session-parking
```

The launcher in `~/.local/bin/omp-park` runs:

```text
~/work/projects/oh-my-pi/packages/coding-agent/dist/omp
```

Updating the branch does nothing to the installed binary until `bun run build` succeeds.

## Repository layout

Working copy:

```text
~/work/projects/oh-my-pi
```

Remotes:

```text
origin  can1357/oh-my-pi       fetch only
igor    IgorKhramtsov/oh-my-pi fetch and push
```

Branches:

```text
main                 clean mirror of origin/main; never deployed
feat/session-parking stable release tag plus personal parking commit
```

`origin/main` moves quickly. Release tags are deployment baselines.

## One-time setup

Already applied to the working copy.

```bash
cd ~/work/projects/oh-my-pi

git remote set-url origin ssh://git@github.com/can1357/oh-my-pi.git
git remote set-url --push origin DISABLED
git remote add igor ssh://git@github.com/IgorKhramtsov/oh-my-pi.git  # only if absent
git config remote.pushDefault igor
```

The disabled `origin` push URL prevents accidental writes to upstream. `git push` defaults to the personal fork.

## Update to a stable release

Start clean:

```bash
cd ~/work/projects/oh-my-pi
git status --short
git fetch origin main --tags --prune
```

Stop if the working tree is not clean.

Read the latest published release and current parking base:

```bash
stable=$(gh release view \
  --repo can1357/oh-my-pi \
  --json tagName \
  --jq .tagName)

git switch feat/session-parking
base=$(git describe --tags --exact-match "$(git merge-base HEAD "$stable")")
printf 'parking base: %s\nlatest stable: %s\n' "$base" "$stable"
```

If both tags match, no rebase is needed.

Record the remote commit before rewriting the branch:

```bash
remote_sha=$(git ls-remote igor refs/heads/feat/session-parking | cut -f1)
test -n "$remote_sha"
```

Rebase the personal patch:

```bash
git rebase --onto "$stable" "$base" feat/session-parking
```

Conflict handling:

```bash
git status
# Resolve the design against the new upstream code.
git add <resolved-files>
git rebase --continue
```

Abort if the old design no longer fits:

```bash
git rebase --abort
```

Do not accept both sides mechanically. Lockfiles, versions, changelogs, release metadata, Nix files, and generated files belong to upstream unless the parking patch genuinely changes them.

## Inspect the rebased patch

```bash
git log --oneline --decorate "$stable"..HEAD
git diff --stat "$stable"...HEAD
git diff --check "$stable"...HEAD
```

Expected result: only the personal parking commit above the release tag. Investigate unrelated files before testing.

## Verify

```bash
cd ~/work/projects/oh-my-pi/packages/coding-agent

bun run check:types
bun test \
  test/session-parking.test.ts \
  test/lsp/mux-park-release.test.ts \
  test/main-cross-project-resume.test.ts \
  test/mcp/transports/stdio.test.ts \
  test/lsp/idle.test.ts \
  test/cli-command-metadata.test.ts \
  test/modes/components/session-selector-status.test.ts
bun run build
```

Exercise the installed path:

```bash
OMP_PARK_IDLE=1s omp --no-lsp --no-extensions
```

Check all behavior:

1. Editor accepts input.
2. Warning appears after one idle second.
3. Any key cancels the warning.
4. Parking preserves the latest conversation and unsent draft.
5. Enter resumes the exact session in the same pane.
6. Esc releases the session and prints the `omp --resume` command.
7. Parked wrapper has no OMP child process.

## Publish

Push only after every check passes:

```bash
cd ~/work/projects/oh-my-pi

git push \
  --force-with-lease=refs/heads/feat/session-parking:"$remote_sha" \
  igor HEAD:refs/heads/feat/session-parking
```

The explicit lease rejects the push if the remote branch changed after `remote_sha` was captured. Never replace it with `--force`.

Verify local and remote commits match:

```bash
local_sha=$(git rev-parse HEAD)
pushed_sha=$(git ls-remote igor refs/heads/feat/session-parking | cut -f1)
test "$local_sha" = "$pushed_sha"
```

## Sync fork main

Keep fork `main` as a clean upstream mirror. This does not deploy it.

```bash
cd ~/work/projects/oh-my-pi

git fetch origin main --prune
git switch main
git merge --ff-only origin/main
git push igor main
git switch feat/session-parking
```

## Rules

- Update when a stable release contains a needed fix or feature.
- Rebase onto published, non-prerelease tags. Never deploy `origin/main` directly.
- Keep personal changes off `main`.
- Keep parking as a small patch stack.
- Use `--force-with-lease`, never `--force`.
- Do not run `scripts/release.ts`; it versions, regenerates, commits, tags, and pushes upstream release state.
- Rebuild after every successful rebase. Dotfiles need no change unless the launcher contract changes.
