import { describe, expect, it } from "vite-plus/test";

import {
  BoatApiError,
  ensureBoatSandboxRunning,
  makeBoatClient,
  parseBoatSshAccess,
} from "./boatApi.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoatHostKeyForTests";

describe("parseBoatSshAccess", () => {
  it("prefers the mapped endpoint on shared hosts", () => {
    expect(
      parseBoatSshAccess({
        sshEndpoint: "203.0.113.10:22001",
        machineIp: null,
        sshUser: "user",
        hostKey: HOST_KEY,
      }),
    ).toEqual({ hostname: "203.0.113.10", port: 22001, username: "user", hostKey: HOST_KEY });
  });

  it("uses port 22 on a dedicated IP", () => {
    expect(
      parseBoatSshAccess({ machineIp: "198.51.100.7", sshUser: "user", hostKey: HOST_KEY }).port,
    ).toBe(22);
  });

  it("refuses to connect without a host key to pin", () => {
    expect(() => parseBoatSshAccess({ machineIp: "198.51.100.7", sshUser: "user" })).toThrow(
      BoatApiError,
    );
  });
});

type Call = { method: string; path: string; body: unknown };

function fakeBoat(states: string[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input).replace("https://boat.dev/api/v1", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const state = method === "GET" ? (states.shift() ?? "idle") : "idle";
    return new Response(JSON.stringify({ ok: true, sandbox: { id: "bx_abcd2345", state } }), {
      status: 200,
    });
  };
  return { calls, client: makeBoatClient({ apiKey: "boat_test", fetch }) };
}

const noSleep = async () => {};

describe("ensureBoatSandboxRunning", () => {
  it("resumes an archived VM once with the idle window as its timer", async () => {
    const { calls, client } = fakeBoat(["archived", "provisioning", "archived", "idle"]);
    await ensureBoatSandboxRunning(client, "bx_abcd2345", 3600, { sleep: noSleep });
    const mutations = calls.filter((call) => call.method !== "GET");
    expect(mutations).toEqual([
      { method: "POST", path: "/sandboxes/bx_abcd2345/resume", body: { ttlSeconds: 3600 } },
    ]);
  });

  it("waits for an in-flight archive before resuming", async () => {
    const { calls, client } = fakeBoat(["archiving", "archiving", "archived", "idle"]);
    await ensureBoatSandboxRunning(client, "bx_abcd2345", 600, { sleep: noSleep });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /sandboxes/bx_abcd2345",
      "GET /sandboxes/bx_abcd2345",
      "GET /sandboxes/bx_abcd2345",
      "POST /sandboxes/bx_abcd2345/resume",
      "GET /sandboxes/bx_abcd2345",
    ]);
  });

  it("leaves the auto-stop timer of a running VM to the VM", async () => {
    const { calls, client } = fakeBoat(["running"]);
    await ensureBoatSandboxRunning(client, "bx_abcd2345", 900, { sleep: noSleep });
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("fails on a VM Boat could not place", async () => {
    const { client } = fakeBoat(["cancelled"]);
    await expect(
      ensureBoatSandboxRunning(client, "bx_abcd2345", 900, { sleep: noSleep }),
    ).rejects.toThrow(/unavailable/);
  });
});

describe("makeBoatClient", () => {
  it("does not echo the API key in errors", async () => {
    const client = makeBoatClient({
      apiKey: "boat_secretvalue",
      fetch: async () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }),
    });
    const error = await client.getSandbox("bx_abcd2345").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BoatApiError);
    expect(String((error as Error).message)).not.toContain("boat_secretvalue");
  });
});
