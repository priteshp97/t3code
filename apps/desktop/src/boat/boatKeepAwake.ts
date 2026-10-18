import { OrchestrationV2RunStatus } from "@t3tools/contracts";

/**
 * Boat's auto-stop timer counts wall time, not work. A helper on the VM watches
 * T3's run projection and pushes the timer out while an agent run is unfinished,
 * so closing the desktop app never cuts a turn short and an idle VM still stops.
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
export const BOAT_KEEP_AWAKE_DIR = "/opt/t3code-boat";

/**
 * Runs under systemd as the Boat `user`. `boat extend self` authenticates with
 * the sandbox's own token, which can only touch this VM, so no API key lives here.
 */
export function boatKeepAwakeScript(): string {
  return `// Managed by T3 Code. Keeps this Boat VM awake while a T3 agent run is unfinished.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const graceSeconds = Math.max(120, Number(process.env.T3_BOAT_GRACE_SECONDS) || 900);
const dbPath = process.env.T3_BOAT_STATE_DB || \`\${process.env.HOME}/.t3/userdata/statev2.sqlite\`;
const active = ${JSON.stringify(BOAT_ACTIVE_RUN_STATUSES)};
const waitingLimitMs = ${BOAT_WAITING_RUN_LIMIT_SECONDS * 1000};
const pollMs = 60_000;
const boatCli = process.env.T3_BOAT_CLI || "boat";
// Re-arm well before the timer can run out between polls.
const extendEveryMs = Math.min(4 * 60_000, (graceSeconds * 1000) / 2);
let lastExtend = 0;

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
    // No database yet (T3 never started here) means no work.
    if (!String(error?.message).includes("unable to open")) console.error("t3 run check failed:", error?.message ?? error);
    return false;
  } finally {
    db?.close();
  }
}

function extend() {
  // A login shell carries the sandbox token Boat injects for the CLI.
  execFileSync("bash", ["-lc", 'exec "$0" extend self --ttl "$1"', boatCli, String(graceSeconds)], {
    stdio: "ignore",
    timeout: 60_000,
    env: { ...process.env, BOAT_NO_UPDATE: "true" },
  });
  lastExtend = Date.now();
  console.log(\`agent work in progress; VM stays on for at least \${graceSeconds}s\`);
}

function tick() {
  if (!busy() || Date.now() - lastExtend < extendEveryMs) return;
  try {
    extend();
  } catch (error) {
    console.error("boat extend failed:", error?.message ?? error);
  }
}

tick();
if (!process.argv.includes("--once")) setInterval(tick, pollMs);
`;
}

/**
 * Installs or refreshes the helper and (re)starts it. Snapshot restores bring back
 * unit files without promising the service runs, so this runs on every connect.
 */
export function boatKeepAwakeInstallScript(graceSeconds: number): string {
  const script = boatKeepAwakeScript();
  return `set -eu
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  echo "node is missing on this VM; the keep-awake helper cannot run" >&2
  exit 0
fi
sudo -n install -d -m 755 ${BOAT_KEEP_AWAKE_DIR}
tmp=$(mktemp)
cat > "$tmp" <<'T3_BOAT_KEEP_AWAKE'
${script}T3_BOAT_KEEP_AWAKE
sudo -n install -m 644 "$tmp" ${BOAT_KEEP_AWAKE_DIR}/keep-awake.mjs
cat > "$tmp" <<T3_BOAT_UNIT
[Unit]
Description=T3 Code: keep this Boat VM awake while agents run
After=network-online.target

[Service]
User=$(id -un)
Environment=HOME=$HOME
Environment=T3_BOAT_GRACE_SECONDS=${Math.round(graceSeconds)}
ExecStart=$node_bin ${BOAT_KEEP_AWAKE_DIR}/keep-awake.mjs
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
T3_BOAT_UNIT
sudo -n install -m 644 "$tmp" /etc/systemd/system/t3code-boat-keep-awake.service
rm -f "$tmp"
sudo -n systemctl daemon-reload
sudo -n systemctl enable --quiet t3code-boat-keep-awake.service
sudo -n systemctl restart t3code-boat-keep-awake.service
`;
}
