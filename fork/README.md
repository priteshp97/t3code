# Boat fork of T3 Code

`priteshp97/t3code` is upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
plus a small patch on the `boat` branch: Boat.dev VM environments in the desktop
app. Everything else is upstream. The fork publishes its own nightly prereleases so
that its installs keep getting builds that include the patch:

- the Windows x64 desktop app (NSIS), which updates itself from this fork's
  releases on the nightly channel;
- the Linux x64 `t3` CLI archive, used by `t3 update <version>` on servers and
  installed over SSH on Boat VMs by the desktop app.

Only this directory and `.github/workflows/fork-nightly.yml` are fork-only files.
No upstream file is edited in Git, so the patch cherry-picks cleanly each day.

## The daily build

`.github/workflows/fork-nightly.yml` runs at 05:30 UTC and on demand
(`workflow_dispatch`, with an optional upstream tag and a `force` switch). It only
runs in `priteshp97/t3code`.

1. **prepare** fetches `boat` and upstream (`main` and all tags, without file
   contents) and picks the newest upstream `v*-nightly.*` tag, by date and then run
   number. The patch is every non-merge commit reachable from `boat` but from no
   upstream ref:
   `git rev-list --reverse --no-merges boat --not --remotes=upstream --glob='refs/upstream-tags/*'`.
   This does not depend on which upstream commit `boat` was last rebased onto.
   Upstream tags go into `refs/upstream-tags/` so the fork's own release tags,
   which point at `boat`, cannot hide the patch. The job checks out the tag,
   cherry-picks the patch, and points `CLI_RELEASE_REPOSITORY` in
   `packages/shared/src/cliRelease.ts` at the fork. The sed must change exactly one
   line, or the job fails. It then scans the new commits with gitleaks, typechecks
   contracts, desktop and web, and runs `vp test run apps/desktop/src/boat`.
   Nothing is pushed. The composed tree goes to the build jobs as one binary diff
   against the upstream tag, plus its tree hash. Each job re-applies the diff and
   checks that hash.
2. **linux_cli** builds the JS bundle and the Linux x64 CLI archive the same way
   upstream does, and smoke-tests the archive.
3. **windows_desktop** packages the unsigned NSIS installer, with the Linux archive
   embedded for WSL. It checks that the installer's `app-update.yml` names this repo
   and the `nightly` channel.
4. **publish** creates prerelease `v<version>`, tagged at the `boat` commit that was
   used. The assets are the installer, its blockmap, `nightly.yml`, the CLI archive
   and `SHA256SUMS`. The job then deletes all but the newest 7 fork releases.

If the newest fork release for the same upstream tag already has the same patch
tree hash (recorded in the release notes), the run skips and publishes nothing.
The hash ignores the fork-only CI files.

T3 Connect uses the public values upstream commits in `.env.example`: the Clerk
publishable key, JWT template, CLI OAuth client ID and relay URL. Upstream's relay
client tracing config comes from its Cloudflare state and is not used, so fork
builds send no relay client traces.

## Versions

A fork build keeps the upstream nightly's base version and date. Its last number is
the upstream run number × 100 + N, where N starts at 1 and goes up for each rebuild
of the same upstream tag (at most 99):

    upstream v0.1.1-nightly.20261018.3331  ->  fork v0.1.1-nightly.20261018.333101, 333102, ...

This still matches the nightly patterns in `cliReleaseChannelOf` and
`updateChannels.ts`, and it sorts above the upstream nightly it was built from.

## One-time setup

- Make `boat` the default branch, because scheduled workflows only run there:
  `gh repo edit priteshp97/t3code --default-branch boat`
- Enable Actions on the fork. Also enable issues, which conflict reports need:
  `gh repo edit priteshp97/t3code --enable-issues`
- Disable the upstream workflows that would run on pushes or schedules here:

  ```sh
  gh workflow disable ci.yml --repo priteshp97/t3code
  gh workflow disable cursor-hygiene-webhook.yml --repo priteshp97/t3code
  gh workflow disable deploy-relay.yml --repo priteshp97/t3code
  gh workflow disable issue-labels.yml --repo priteshp97/t3code
  gh workflow disable mobile-android-apk.yml --repo priteshp97/t3code
  gh workflow disable mobile-eas-production.yml --repo priteshp97/t3code
  gh workflow disable pr-vouch.yml --repo priteshp97/t3code
  gh workflow disable release.yml --repo priteshp97/t3code
  ```

- Windows: install one fork release by hand. From then on, the app updates from the
  fork. An upstream install keeps following upstream.
- Linux server: install one fork CLI. From then on, `t3 update <version> --yes`
  downloads from the fork:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/priteshp97/t3code/boat/scripts/install.sh \
    | T3CODE_VERSION=<fork version> \
      T3CODE_RELEASE_BASE_URL=https://github.com/priteshp97/t3code/releases/download sh
  ```

## When the patch no longer applies

The run opens or updates an issue called "Nightly rebase conflict: <tag>" that
lists the conflicting files. The run then fails, and nothing is published. To fix
it locally:

```sh
git fetch upstream --tags
tag=$(UPSTREAM_TAG_NS=refs/tags fork/compose.sh latest-tag)
git switch boat
git rebase "$tag"            # resolve conflicts, then git rebase --continue
vp install
vp run --filter @t3tools/contracts --filter @t3tools/desktop --filter @t3tools/web typecheck
vp test run apps/desktop/src/boat
git push --force-with-lease origin boat        # with your own credentials
gh workflow run fork-nightly.yml --repo priteshp97/t3code
```

Close the issue once a build succeeds.

`fork/compose.sh` runs the same steps as CI. Run `fork/compose.sh` with no
arguments to list its subcommands. In a clone with upstream tags in `refs/tags`,
set `UPSTREAM_TAG_NS=refs/tags`.

## Limits

- Builds are not code-signed, so Windows SmartScreen warns on first install.
- Only win-x64 and linux-x64 are built. Other CLI archives and platforms 404 on the
  fork's releases.
- This fork does not publish the npm launcher, AUR package, hosted web app or
  Android APK.

## Boat VM setup snapshot

New Boat VMs start from the named Boat snapshot `t3code` (the default in the
desktop app's Boat form). `fork/boat-vm-setup.sh` installs the coding setup on a
fresh VM: Node LTS, pnpm, GitHub CLI, Claude Code, Codex, the Vercel and Supabase
CLIs, and agent-browser with its browser. It writes no credentials; Boat delivers
GitHub and agent sign-ins on every start through the account's environment.

To rebuild the snapshot (a VM runs for a couple of minutes, then stops):

    node fork/boat-template.ts --setup fork/boat-vm-setup.sh --snapshot t3code

The script reads a Boat API key from `BOAT_API_KEY` or
`~/.secrets/t3code-boat/api-key`. It needs sandbox create, read, update, stop and
resume, ssh, and snapshot read and write. Never commit the key.
