import { OrchestrationV2RunStatus } from "@t3tools/contracts";

/**
 * Two systemd units make a Boat VM independent of the desktop app:
 *
 * - The T3 server runs as a service. The SSH path adopts a server it did not
 *   launch as "external" and never stops it, so quitting the app cannot kill a
 *   running turn, and the server comes back by itself when the VM resumes.
 * - A keep-awake helper watches T3's run projection and pushes Boat's auto-stop
 *   timer out while an agent run is unfinished, so an idle VM still stops.
 */
const FINISHED_RUN_STATUSES = new Set<string>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** Derived from the contract so a status upstream adds later counts as work. */
export const BOAT_ACTIVE_RUN_STATUSES = OrchestrationV2RunStatus.literals.filter(
  (status) => !FINISHED_RUN_STATUSES.has(status),
);

/** A run left waiting on the user stops counting as work after this long. */
export const BOAT_WAITING_RUN_LIMIT_SECONDS = 2 * 3600;
export const BOAT_VM_DIR = "/opt/t3code-boat";
/** The port the SSH path's own launcher prefers; any port works once adopted. */
export const BOAT_T3_SERVER_PORT = 3773;

/**
 * `node keep-awake.mjs --check` exits 0 while agent work is unfinished; without it
 * the script loops under systemd. `boat extend self` authenticates with the
 * sandbox's own token, which can only touch this VM, so no API key lives here.
 */
export function boatKeepAwakeScript(): string {
  return `// Managed by T3 Code. Keeps this Boat VM awake while a T3 agent run is unfinished.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const graceSeconds = Math.max(120, Number(process.env.T3_BOAT_GRACE_SECONDS) || 900);
const dbPath = process.env.T3_BOAT_STATE_DB || \`\${process.env.HOME}/.t3/userdata/statev2.sqlite\`;
const boatCli = process.env.T3_BOAT_CLI || "boat";
const active = ${JSON.stringify(BOAT_ACTIVE_RUN_STATUSES)};
const waitingLimitMs = ${BOAT_WAITING_RUN_LIMIT_SECONDS * 1000};
const pollMs = 60_000;

function busy() {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const placeholders = active.map(() => "?").join(",");
    const rows = db
      .prepare(\`select status, requested_at as requestedAt from orchestration_v2_projection_runs where status in (\${placeholders})\`)
      .all(...active);
    const now = Date.now();
    return rows.some((row) => row.status !== "waiting" || now - Date.parse(row.requestedAt) < waitingLimitMs);
  } catch (error) {
    // No database or table yet (T3 never ran here) means no work.
    const message = String(error?.message ?? error);
    if (!/unable to open|no such table/.test(message)) console.error("t3 run check failed:", message);
    return false;
  } finally {
    db?.close();
  }
}

function tick() {
  if (!busy()) return;
  try {
    // Every poll while busy: one cheap call keeps a full grace period of margin.
    // A login shell carries the sandbox token Boat injects for its CLI.
    execFileSync("bash", ["-lc", 'exec "$0" extend self --ttl "$1"', boatCli, String(graceSeconds)], {
      stdio: "ignore",
      timeout: 50_000,
      env: { ...process.env, BOAT_NO_UPDATE: "true" },
    });
    console.log(\`agent work in progress; VM stays on for at least \${graceSeconds}s\`);
  } catch (error) {
    console.error("boat extend failed:", error?.message ?? error);
  }
}

if (process.argv.includes("--check")) process.exit(busy() ? 0 : 1);
tick();
if (!process.argv.includes("--once")) setInterval(tick, pollMs);
`;
}

export interface BoatVmSetupOptions {
  readonly graceSeconds: number;
  /** Runs this T3 version as the VM's server; null leaves the SSH path to launch one. */
  readonly server: { readonly version: string; readonly releaseBaseUrl: string } | null;
}

/**
 * Installs or refreshes both units. Snapshot restores bring back unit files
 * without promising the services run, so this runs on every connect.
 */
export function boatVmSetupScript(options: BoatVmSetupOptions): string {
  const keepAwake = boatKeepAwakeScript();
  const server = options.server;
  return `set -eu
node_bin=$(command -v node || true)
sudo -n install -d -m 755 ${BOAT_VM_DIR}
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Writes a root-owned file only when its content changed; prints "changed" if so.
put() {
  if ! sudo -n cmp -s "$tmp" "$1" 2>/dev/null; then
    sudo -n install -m 644 "$tmp" "$1"
    echo changed
  fi
}

if [ -n "$node_bin" ]; then
  cat > "$tmp" <<'T3_BOAT_KEEP_AWAKE'
${keepAwake}T3_BOAT_KEEP_AWAKE
  put ${BOAT_VM_DIR}/keep-awake.mjs >/dev/null
  cat > "$tmp" <<T3_BOAT_UNIT
[Unit]
Description=T3 Code: keep this Boat VM awake while agents run
After=network-online.target

[Service]
User=$(id -un)
Environment=HOME=$HOME
Environment=T3_BOAT_GRACE_SECONDS=${Math.round(options.graceSeconds)}
ExecStart=$node_bin ${BOAT_VM_DIR}/keep-awake.mjs
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
T3_BOAT_UNIT
  put /etc/systemd/system/t3code-boat-keep-awake.service >/dev/null
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --quiet t3code-boat-keep-awake.service
  sudo -n systemctl restart t3code-boat-keep-awake.service
else
  echo "node is missing on this VM; the keep-awake helper cannot run" >&2
fi
${server === null ? "exit 0" : boatServerSetup(server.version, server.releaseBaseUrl)}
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boatServerSetup(version: string, releaseBaseUrl: string): string {
  return `
version=${shellQuote(version)}
base=${shellQuote(releaseBaseUrl.replace(/\/+$/u, ""))}
dir="$HOME/.t3/runtime/versions/$version"
# Same layout and completion marker as the SSH path's own installer, so either reuses the other's.
if [ ! -x "$dir/t3" ] || [ "$(cat "$dir/.install-complete" 2>/dev/null)" != "$version" ]; then
  stage=$(mktemp -d)
  archive="t3-$version-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').tar.gz"
  curl -fsSL --retry 3 -o "$stage/SHA256SUMS" "$base/v$version/SHA256SUMS"
  curl -fsSL --retry 3 -o "$stage/$archive" "$base/v$version/$archive"
  (cd "$stage" && grep " $archive\\$" SHA256SUMS | sha256sum -c - >/dev/null)
  rm -rf "$dir.partial" && mkdir -p "$dir.partial"
  tar -xzf "$stage/$archive" -C "$dir.partial" --strip-components=1
  "$dir.partial/t3" --version >/dev/null
  printf '%s' "$version" > "$dir.partial/.install-complete"
  rm -rf "$dir" && mv "$dir.partial" "$dir"
  rm -rf "$stage"
fi

# A login shell picks up the agent sign-ins Boat injects on every start.
cat > "$tmp" <<'T3_BOAT_RUN'
#!/bin/bash -l
exec "$T3_BIN" serve --host 127.0.0.1 --port ${BOAT_T3_SERVER_PORT} --base-dir "$HOME/.t3"
T3_BOAT_RUN
put ${BOAT_VM_DIR}/run-server.sh >/dev/null
sudo -n chmod 755 ${BOAT_VM_DIR}/run-server.sh
cat > "$tmp" <<T3_BOAT_SERVER
[Unit]
Description=T3 Code server for this Boat VM
After=network-online.target

[Service]
User=$(id -un)
Environment=HOME=$HOME
Environment=T3_BIN=$dir/t3
Environment=T3CODE_NO_BROWSER=1
ExecStart=${BOAT_VM_DIR}/run-server.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
T3_BOAT_SERVER
changed=$(put /etc/systemd/system/t3code-boat-server.service)
sudo -n systemctl daemon-reload
sudo -n systemctl enable --quiet t3code-boat-server.service
if ! systemctl is-active --quiet t3code-boat-server.service; then
  # A server the SSH path launched earlier owns the state directory; leave it be.
  if ! pgrep -u "$(id -u)" -f " serve --host 127.0.0.1 " >/dev/null; then
    sudo -n systemctl start t3code-boat-server.service
  fi
elif [ -n "$changed" ]; then
  # A new version waits while an agent is working, so an update never cuts a turn.
  if [ -n "$node_bin" ] && "$node_bin" ${BOAT_VM_DIR}/keep-awake.mjs --check; then
    echo "T3 update deferred until agents finish" >&2
  else
    sudo -n systemctl restart t3code-boat-server.service
  fi
fi
# Ready before the SSH path probes, so it adopts this server instead of launching one.
for _ in $(seq 1 60); do
  curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:${BOAT_T3_SERVER_PORT}/.well-known/t3/environment" && exit 0
  sleep 1
done
echo "T3 server service did not become ready" >&2
exit 1
`;
}
