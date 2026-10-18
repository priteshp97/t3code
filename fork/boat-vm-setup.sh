#!/usr/bin/env bash
# Installs the T3 Code coding setup on a fresh Boat VM. Runs as the Boat `user`
# (passwordless sudo). Safe to re-run. Writes no credentials: Boat delivers
# GitHub and agent sign-ins itself on every start.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

log() { printf '\n==> %s\n' "$*"; }

arch=$(uname -m)
case "$arch" in
  x86_64) node_arch=x64; deb_arch=amd64 ;;
  aarch64) node_arch=arm64; deb_arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

log "Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates git jq unzip xz-utils build-essential python3 >/dev/null

log "Node.js (latest LTS)"
lts=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version')
if [ "$(node --version 2>/dev/null || true)" != "$lts" ]; then
  work=$(mktemp -d)
  curl -fsSL -o "$work/node.tar.xz" "https://nodejs.org/dist/$lts/node-$lts-linux-$node_arch.tar.xz"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/$lts/SHASUMS256.txt"
  (cd "$work" && grep " node-$lts-linux-$node_arch.tar.xz\$" SHASUMS256.txt | sed "s/node-$lts-linux-$node_arch.tar.xz/node.tar.xz/" | sha256sum -c -)
  sudo tar -xJf "$work/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$work"
fi
node --version

log "GitHub CLI"
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  echo "deb [arch=$deb_arch signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh >/dev/null
fi
# Lets git use whichever GitHub token Boat delivers, without storing it.
git config --global credential.https://github.com.helper '!gh auth git-credential'
git config --global init.defaultBranch main

log "Global npm tools"
# Boat keeps its own preinstalled agents updated; only add what is missing.
npm_tools=(pnpm vercel agent-browser)
command -v claude >/dev/null || npm_tools+=(@anthropic-ai/claude-code)
command -v codex >/dev/null || npm_tools+=(@openai/codex)
# npm 11 skips install scripts unless allowed; these tools need theirs.
sudo npm install --global --no-fund --no-audit \
  --allow-scripts=agent-browser,pnpm,esbuild,@anthropic-ai/claude-code,@openai/codex \
  "${npm_tools[@]}" >/dev/null

log "Supabase CLI"
if ! command -v supabase >/dev/null; then
  deb_url=$(curl -fsSL https://api.github.com/repos/supabase/cli/releases/latest |
    jq -r --arg a "linux_$deb_arch.deb" '.assets[] | select(.name | endswith($a)) | .browser_download_url' | head -n1)
  work=$(mktemp -d)
  curl -fsSL -o "$work/supabase.deb" "$deb_url"
  sudo apt-get install -y -qq "$work/supabase.deb" >/dev/null
  rm -rf "$work"
fi

log "Browser for agent-browser"
agent-browser install --with-deps >/dev/null 2>&1 || agent-browser install --with-deps

log "Versions"
for tool in node npm pnpm git gh claude codex vercel supabase agent-browser; do
  printf '%-14s %s\n' "$tool" "$("$tool" --version 2>/dev/null | head -n1 || echo missing)"
done

# Drop caches so the snapshot stays small.
sudo apt-get clean
npm cache clean --force >/dev/null 2>&1 || true
