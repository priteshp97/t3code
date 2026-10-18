// Creates a Boat VM, runs the T3 Code setup script on it, checks agent sign-ins and
// the t3 runtime, optionally saves it as a named snapshot, and always stops the VM.
// Usage (from the repo root): node fork/boat-template.ts --setup <script> [--snapshot t3code] [--t3-version <v>] [--keep]
// Reads the Boat API key from BOAT_API_KEY or ~/.secrets/t3code-boat/api-key.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ensureBoatSandboxRunning, makeBoatClient } from "../apps/desktop/src/boat/boatApi.ts";

const { values } = parseArgs({
  options: {
    setup: { type: "string" },
    snapshot: { type: "string" },
    from: { type: "string" },
    "t3-version": { type: "string" },
    keep: { type: "boolean", default: false },
    size: { type: "string", default: "default" },
  },
});

const apiKey =
  process.env.BOAT_API_KEY?.trim() ||
  readFileSync(join(homedir(), ".secrets/t3code-boat/api-key"), "utf8").trim();
const client = makeBoatClient({ apiKey });
const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`https://boat.dev/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${body.code ?? ""} ${body.message ?? ""}`,
    );
  return body;
};
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const work = mkdtempSync(join(tmpdir(), "t3boat-"));
execFileSync("ssh-keygen", [
  "-q",
  "-t",
  "ed25519",
  "-N",
  "",
  "-C",
  "t3boat-test",
  "-f",
  join(work, "id"),
]);

const t0 = Date.now();
const sandbox = await client.createSandbox({
  size: values.size as "default",
  ttlSeconds: 3600,
  idempotencyKey: randomUUID(),
  ...(values.from ? { fromSnapshot: values.from } : {}),
});
writeFileSync(join(work, "sandbox-id"), sandbox.id);
log("created", sandbox.id, "work dir", work);

const sshArgs = (access: { hostname: string; port: number; username: string }) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${join(work, "known_hosts")}`,
  "-o",
  "HostKeyAlias=t3boat-test",
  "-o",
  "IdentitiesOnly=yes",
  "-i",
  join(work, "id"),
  "-p",
  String(access.port),
  `${access.username}@${access.hostname}`,
];
const runRemote = (args: string[], script: string, label: string) => {
  log(`--- ${label}`);
  const result = spawnSync("ssh", [...args, "bash -l -s"], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 45 * 60_000,
  });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
};

try {
  const running = await ensureBoatSandboxRunning(client, sandbox.id, 3600, {
    timeoutMs: 10 * 60_000,
  });
  log("running", running.state, `after ${Math.round((Date.now() - t0) / 1000)}s`);
  const access = await client.configureSshKey(
    sandbox.id,
    readFileSync(join(work, "id.pub"), "utf8").trim(),
  );
  writeFileSync(join(work, "known_hosts"), `t3boat-test ${access.hostKey}\n`);
  log("ssh", `${access.username}@${access.hostname}:${access.port}`);
  const args = sshArgs(access);
  for (let i = 0; i < 30; i++) {
    if (spawnSync("ssh", [...args, "true"], { timeout: 20_000 }).status === 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  log("ssh ready", `after ${Math.round((Date.now() - t0) / 1000)}s`);

  runRemote(
    args,
    `uname -a; . /etc/os-release; echo "$PRETTY_NAME"; nproc; free -g | head -2; df -h / | tail -1`,
    "machine",
  );
  // Names only, never values.
  runRemote(
    args,
    `echo "login-shell credential variables:"; env | cut -d= -f1 | grep -E 'CLAUDE|ANTHROPIC|OPENAI|CODEX|GITHUB|GH_|BOAT' | sort; ls -la ~/.codex 2>/dev/null | awk '{print $NF}' | tr '\\n' ' '; echo`,
    "credentials (names only)",
  );

  if (values.setup) runRemote(args, readFileSync(values.setup, "utf8"), "setup script");

  runRemote(
    args,
    `set +e
claude --version; claude auth status 2>&1 | head -5
codex --version; codex login status 2>&1 | head -3
gh auth status 2>&1 | grep -E 'Logged in|not logged' | head -2
git ls-remote https://github.com/priteshp97/t3code HEAD >/dev/null 2>&1 && echo "git over https: ok" || echo "git over https: FAILED"`,
    "agent sign-ins",
  );

  if (values["t3-version"]) {
    const v = values["t3-version"];
    runRemote(
      args,
      `set -e
base=https://github.com/pingdotgg/t3code/releases/download/v${v}
d=$(mktemp -d); cd "$d"
curl -fsSLO "$base/t3-${v}-linux-x64.tar.gz"; curl -fsSLO "$base/SHA256SUMS"
grep " t3-${v}-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -
mkdir -p ~/.t3/runtime/versions/${v} && tar -xzf t3-${v}-linux-x64.tar.gz -C ~/.t3/runtime/versions/${v} --strip-components=1
~/.t3/runtime/versions/${v}/t3 --version`,
      "t3 runtime",
    );
  }

  if (values.snapshot) {
    await api("/named-snapshots", {
      method: "POST",
      body: JSON.stringify({ sandboxId: sandbox.id, name: values.snapshot }),
    });
    for (;;) {
      const { snapshot } = await api(`/named-snapshots/${values.snapshot}`);
      log("snapshot", snapshot?.status, snapshot?.sizeBytes ?? "");
      if (snapshot?.status === "ready") break;
      if (snapshot?.status === "failed") throw new Error(`snapshot failed: ${snapshot.error}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
} finally {
  if (!values.keep) {
    await client.stopSandbox(sandbox.id).catch((e) => log("stop failed", e.message));
    log("stop requested", sandbox.id);
  } else {
    log("kept running", sandbox.id);
  }
  const usage = await api(`/sandboxes/${sandbox.id}/usage`).catch(() => null);
  if (usage) log("usage", JSON.stringify(usage).slice(0, 300));
}
