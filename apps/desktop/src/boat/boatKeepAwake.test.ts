// @effect-diagnostics nodeBuiltinImport:off - Runs the generated VM helper as a real Node process.
// @effect-diagnostics globalDate:off - Seeds wall-clock timestamps the helper compares against.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  BOAT_ACTIVE_RUN_STATUSES,
  boatKeepAwakeInstallScript,
  boatKeepAwakeScript,
} from "./boatKeepAwake.ts";

let dir: string;

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boat-keep-awake-"));
});
afterEach(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

function seedRuns(rows: ReadonlyArray<{ status: string; requestedAt?: string }>) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "state.sqlite"));
  db.exec(
    "create table orchestration_v2_projection_runs (run_id text primary key, thread_id text not null, status text not null, requested_at text not null)",
  );
  const insert = db.prepare("insert into orchestration_v2_projection_runs values (?, 't', ?, ?)");
  rows.forEach((row, index) =>
    insert.run(`run-${index}`, row.status, row.requestedAt ?? new Date().toISOString()),
  );
  db.close();
}

/** Runs one poll of the helper with a fake `boat` that records its arguments. */
function pollOnce(): string[] {
  const script = NodePath.join(dir, "keep-awake.mjs");
  NodeFS.writeFileSync(script, boatKeepAwakeScript());
  const calls = NodePath.join(dir, "calls.txt");
  const fakeBoat = NodePath.join(dir, "boat");
  NodeFS.writeFileSync(fakeBoat, `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
  NodeChildProcess.execFileSync(process.execPath, [script, "--once"], {
    env: {
      ...process.env,
      T3_BOAT_STATE_DB: NodePath.join(dir, "state.sqlite"),
      T3_BOAT_CLI: fakeBoat,
      T3_BOAT_GRACE_SECONDS: "900",
    },
    stdio: "pipe",
  });
  return NodeFS.existsSync(calls) ? NodeFS.readFileSync(calls, "utf8").trim().split("\n") : [];
}

describe("Boat keep-awake helper", () => {
  it("keeps the VM on while an agent run is unfinished", () => {
    seedRuns([{ status: "completed" }, { status: "running" }]);
    expect(pollOnce()).toEqual(["extend self --ttl 900"]);
  });

  it("lets an idle VM stop", () => {
    seedRuns([{ status: "completed" }, { status: "failed" }, { status: "interrupted" }]);
    expect(pollOnce()).toEqual([]);
  });

  it("stops counting a run left waiting on the user for hours", () => {
    seedRuns([
      { status: "waiting", requestedAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
    ]);
    expect(pollOnce()).toEqual([]);
  });

  it("treats a VM where T3 never started as idle", () => {
    expect(pollOnce()).toEqual([]);
  });

  it("counts every unfinished run status, including queued and waiting", () => {
    expect(BOAT_ACTIVE_RUN_STATUSES).toEqual(
      expect.arrayContaining(["queued", "preparing", "starting", "running", "waiting"]),
    );
    expect(BOAT_ACTIVE_RUN_STATUSES).not.toContain("completed");
  });

  it("is a valid shell script that installs the helper verbatim", () => {
    const install = boatKeepAwakeInstallScript(900);
    NodeChildProcess.execFileSync("bash", ["-n"], { input: install });
    expect(install).toContain(boatKeepAwakeScript());
    expect(install).toContain("Environment=T3_BOAT_GRACE_SECONDS=900");
  });
});
