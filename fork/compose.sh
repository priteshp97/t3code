#!/usr/bin/env bash
# Composes the Boat fork's build tree: an upstream T3 Code nightly tag plus the
# fork's patch commits from the `boat` branch, then the build-time rebrand.
# Shared by .github/workflows/fork-nightly.yml and local use. Run it from the
# root of a t3code checkout. See fork/README.md.
#
# Subcommands:
#   fetch-upstream                     fetch upstream main and tags (blobless)
#   latest-tag                         newest upstream v*-nightly.* tag
#   patch-commits <patch-ref> <tag>    fork patch commits, oldest first
#   compose <tag> <patch-ref> [file]   check out <tag> and cherry-pick the patch;
#                                      exit 3 on conflict, conflict report in [file]
#   patch-hash [rev]                   tree hash of [rev] without fork CI files
#   rebrand <owner/repo>               point CLI release downloads at <owner/repo>
#   next-n <tag>                       next fork build number for <tag>, given
#                                      existing fork release tags on stdin
#   fork-version <tag> <n>             fork version for upstream <tag>, build <n>
#   verify-version <version>           check <version> against the nightly regexes
#   export <tag> <out.patch>           write tag..HEAD as one binary diff, print tree
#   apply <commit> <patch> <tree>      rebuild the composed tree on top of <commit>
#
# Environment:
#   UPSTREAM_TAG_NS    ref namespace holding upstream tags (default refs/upstream-tags;
#                      use refs/tags in a plain local clone of upstream)
#   UPSTREAM_REMOTE    remote name for upstream (default upstream)
#   MAX_PATCH_COMMITS  sanity cap on the patch size (default 50)

set -euo pipefail

UPSTREAM_TAG_NS="${UPSTREAM_TAG_NS:-refs/upstream-tags}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}"
MAX_PATCH_COMMITS="${MAX_PATCH_COMMITS:-50}"
NIGHTLY_TAG_RE='^v([^-+]+)-nightly\.([0-9]{8})\.([0-9]+)$'
# Same shape as cliReleaseChannelOf (packages/shared/src/cliRelease.ts) and
# NIGHTLY_VERSION_PATTERN (apps/desktop/src/updates/updateChannels.ts).
NIGHTLY_VERSION_RE='^[^-+]+-nightly\.[0-9]{8}\.[0-9]+$'
# Fork-only CI files: they never affect the shipped app, so they are left out
# of the patch hash that decides whether a build is new.
FORK_PATHS=(fork '.github/workflows/fork-*.yml')
CLI_RELEASE_FILE=packages/shared/src/cliRelease.ts
CLI_RELEASE_LINE='const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";'

git_ci() {
  git -c user.name="t3code fork CI" -c user.email="fork-ci@users.noreply.github.com" "$@"
}

die() {
  printf 'compose: %s\n' "$*" >&2
  exit 1
}

tag_ref() {
  printf '%s/%s' "$UPSTREAM_TAG_NS" "$1"
}

tag_commit() {
  git rev-parse --verify --quiet "$(tag_ref "$1")^{commit}" || die "unknown upstream tag $1 (looked in $UPSTREAM_TAG_NS)"
}

cmd_fetch_upstream() {
  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi
  git fetch --quiet --filter=blob:none --no-tags "$UPSTREAM_REMOTE" \
    "+refs/heads/main:refs/remotes/$UPSTREAM_REMOTE/main" \
    "+refs/tags/v*:$UPSTREAM_TAG_NS/v*"
}

cmd_latest_tag() {
  local ref tag latest
  latest="$(
    git for-each-ref --format='%(refname)' "$UPSTREAM_TAG_NS" | while read -r ref; do
      tag="${ref#"$UPSTREAM_TAG_NS"/}"
      if [[ "$tag" =~ $NIGHTLY_TAG_RE ]]; then
        printf '%s %s %s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "$tag"
      fi
    done | sort -k1,1n -k2,2n | tail -n 1 | cut -d' ' -f3
  )"
  [[ -n "$latest" ]] || die "no upstream nightly tags under $UPSTREAM_TAG_NS"
  printf '%s\n' "$latest"
}

# The patch is every non-merge commit reachable from the patch branch but from
# no upstream ref (upstream main, any upstream tag, and the chosen tag). That
# does not depend on which upstream commit `boat` was last rebased onto, and it
# keeps working if upstream is merged into `boat` instead of rebased. The cap
# catches a missing upstream fetch, which would otherwise list all of history.
cmd_patch_commits() {
  local patch_ref="$1" tag="$2" base commits count
  base="$(tag_commit "$tag")"
  commits="$(git rev-list --reverse --no-merges "$patch_ref" \
    --not --remotes="$UPSTREAM_REMOTE" --glob="$UPSTREAM_TAG_NS/*" "$base")"
  count="$(printf '%s' "$commits" | grep -c . || true)"
  ((count > 0)) || die "no patch commits on $patch_ref beyond upstream"
  ((count <= MAX_PATCH_COMMITS)) || die "$count patch commits on $patch_ref (cap $MAX_PATCH_COMMITS); is upstream fetched?"
  printf '%s\n' "$commits"
}

cmd_compose() {
  local tag="$1" patch_ref="$2" report="${3:-/dev/stderr}" base list failed
  local -a commits
  base="$(tag_commit "$tag")"
  list="$(cmd_patch_commits "$patch_ref" "$tag")"
  mapfile -t commits <<<"$list"
  git -c advice.detachedHead=false checkout --quiet --detach "$base"
  if git_ci cherry-pick --empty=drop -x "${commits[@]}" >&2; then
    printf 'compose: %s + %d patch commit(s) -> %s\n' "$tag" "${#commits[@]}" "$(git rev-parse HEAD)" >&2
    return 0
  fi
  if ! git rev-parse --verify --quiet CHERRY_PICK_HEAD >/dev/null; then
    die "cherry-pick failed without a conflict"
  fi
  failed="$(git rev-parse CHERRY_PICK_HEAD)"
  {
    printf 'Conflict applying %s (%s) onto %s.\n\nConflicting files:\n' \
      "$failed" "$(git log -1 --format=%s "$failed")" "$tag"
    git diff --name-only --diff-filter=U | sed 's/^/- /'
  } >"$report"
  git cherry-pick --abort
  return 3
}

cmd_patch_hash() {
  local rev="${1:-HEAD}" dir tree
  dir="$(mktemp -d)"
  GIT_INDEX_FILE="$dir/index" git read-tree "$rev"
  GIT_INDEX_FILE="$dir/index" git rm -r -q --cached --sparse --ignore-unmatch -- "${FORK_PATHS[@]}"
  tree="$(GIT_INDEX_FILE="$dir/index" git write-tree)"
  rm -rf "$dir"
  printf '%s\n' "$tree"
}

cmd_rebrand() {
  local repo="$1" new numstat tmp
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid repository $repo"
  new="const CLI_RELEASE_REPOSITORY = \"$repo\";"
  [[ "$(grep -cxF "$CLI_RELEASE_LINE" "$CLI_RELEASE_FILE" || true)" == 1 ]] ||
    die "expected exactly one '$CLI_RELEASE_LINE' in $CLI_RELEASE_FILE"
  tmp="$(mktemp)"
  sed -E "s#^const CLI_RELEASE_REPOSITORY = \"pingdotgg/t3code\";\$#const CLI_RELEASE_REPOSITORY = \"$repo\";#" \
    "$CLI_RELEASE_FILE" >"$tmp"
  cat "$tmp" >"$CLI_RELEASE_FILE"
  rm -f "$tmp"
  numstat="$(git diff --numstat -- "$CLI_RELEASE_FILE")"
  [[ "$numstat" == "1	1	$CLI_RELEASE_FILE" ]] || die "rebrand changed more than one line: ${numstat:-nothing}"
  [[ "$(grep -cxF "$new" "$CLI_RELEASE_FILE" || true)" == 1 ]] || die "rebrand line missing after sed"
  git add -- "$CLI_RELEASE_FILE"
  git_ci commit --quiet --no-verify -m "fork: download CLI releases from $repo"
}

cmd_next_n() {
  local tag="$1" base date run line n max=0
  [[ "$tag" =~ $NIGHTLY_TAG_RE ]] || die "not a nightly tag: $tag"
  base="${BASH_REMATCH[1]}" date="${BASH_REMATCH[2]}" run="${BASH_REMATCH[3]}"
  while read -r line; do
    if [[ "$line" == "v$base-nightly.$date.$run"[0-9][0-9] ]]; then
      n=$((10#${line: -2}))
      ((n > max)) && max=$n
    fi
  done
  ((max < 99)) || die "fork build numbers for $tag are exhausted"
  printf '%d\n' $((max + 1))
}

cmd_fork_version() {
  local tag="$1" n="$2" base date run
  [[ "$tag" =~ $NIGHTLY_TAG_RE ]] || die "not a nightly tag: $tag"
  base="${BASH_REMATCH[1]}" date="${BASH_REMATCH[2]}" run="${BASH_REMATCH[3]}"
  if [[ ! "$n" =~ ^[0-9]+$ ]] || ((10#$n < 1 || 10#$n > 99)); then
    die "build number must be 1-99, got $n"
  fi
  printf '%s-nightly.%s.%d\n' "$base" "$date" $((10#$run * 100 + 10#$n))
}

# Checks the shell regex and, from a composed checkout, the TypeScript sources
# the CLI installer and the desktop updater actually use.
cmd_verify_version() {
  local version="$1"
  [[ "$version" =~ $NIGHTLY_VERSION_RE ]] || die "$version does not look like a nightly version"
  [[ -f "$CLI_RELEASE_FILE" ]] || return 0
  node --input-type=module - "$version" <<'EOF'
import { pathToFileURL } from "node:url";
const version = process.argv[2];
const root = pathToFileURL(`${process.cwd()}/`);
const cli = await import(new URL("packages/shared/src/cliRelease.ts", root));
const desktop = await import(new URL("apps/desktop/src/updates/updateChannels.ts", root));
const checks = {
  cliReleaseChannelOf: cli.cliReleaseChannelOf(version) === "nightly",
  resolveDefaultDesktopUpdateChannel: desktop.resolveDefaultDesktopUpdateChannel(version) === "nightly",
  isNightlyDesktopVersion: desktop.isNightlyDesktopVersion(version) === true,
  buildDesktopArtifactChannel: /-nightly\.\d{8}\.\d+$/.test(version),
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`compose: ${version} is not a nightly version for: ${failed.join(", ")}`);
  process.exit(1);
}
EOF
}

cmd_export() {
  local tag="$1" out="$2" base
  base="$(tag_commit "$tag")"
  git diff --binary --full-index "$base" HEAD >"$out"
  git rev-parse 'HEAD^{tree}'
}

# Build jobs start from a fresh checkout of the upstream tag commit; the tree
# they end up with must be the one prepare composed and tested.
cmd_apply() {
  local base="$1" patch="$2" expected="$3" tree commit
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$base^{commit}")" ]] || die "HEAD is not $base"
  git apply --cached --whitespace=nowarn "$patch"
  tree="$(git write-tree)"
  [[ "$tree" == "$expected" ]] || die "composed tree $tree does not match expected $expected"
  commit="$(git_ci commit-tree "$tree" -p HEAD -m "Boat fork build tree")"
  git reset --quiet --hard "$commit"
  printf 'compose: checked out composed tree %s\n' "$tree" >&2
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    fetch-upstream) cmd_fetch_upstream "$@" ;;
    latest-tag) cmd_latest_tag "$@" ;;
    patch-commits) cmd_patch_commits "$@" ;;
    compose) cmd_compose "$@" ;;
    patch-hash) cmd_patch_hash "$@" ;;
    rebrand) cmd_rebrand "$@" ;;
    next-n) cmd_next_n "$@" ;;
    fork-version) cmd_fork_version "$@" ;;
    verify-version) cmd_verify_version "$@" ;;
    export) cmd_export "$@" ;;
    apply) cmd_apply "$@" ;;
    *) die "usage: compose.sh <fetch-upstream|latest-tag|patch-commits|compose|patch-hash|rebrand|next-n|fork-version|verify-version|export|apply> ..." ;;
  esac
}

main "$@"
