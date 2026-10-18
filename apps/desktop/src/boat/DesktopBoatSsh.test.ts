import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopBoatEnvironment from "./DesktopBoatEnvironment.ts";
import { stableBoatTarget, withBoat } from "./DesktopBoatSsh.ts";

const boatAlias = "t3-boat-bx_abcd2345";

function run(target: DesktopSshEnvironmentTarget) {
  const seen: DesktopSshEnvironmentTarget[] = [];
  const prepared: string[] = [];
  const inner = Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, {
    discoverHosts: () => Effect.succeed([]),
    resolveHost: () => Effect.die("unused"),
    ensureEnvironment: (requested) => {
      seen.push(requested);
      // The SSH path hands back whatever `ssh -G` resolved, address and mapped port included.
      return Effect.succeed({
        target: { ...requested, hostname: "203.0.113.10", port: 22001 },
        httpBaseUrl: "http://127.0.0.1:4000/",
        wsBaseUrl: "ws://127.0.0.1:4000/",
        pairingToken: null,
      });
    },
    disconnectEnvironment: () => Effect.void,
  });
  const boat = Layer.succeed(DesktopBoatEnvironment.DesktopBoatEnvironment, {
    getSettings: Effect.die("unused"),
    updateSettings: () => Effect.die("unused"),
    createVm: () => Effect.die("unused"),
    prepareTarget: (requested) =>
      Effect.sync(() => {
        prepared.push(requested.alias);
      }),
    wakeVm: () => Effect.void,
    removeVm: () => Effect.void,
  });
  const layer = withBoat(inner).pipe(Layer.provide(boat));
  return Effect.gen(function* () {
    const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const bootstrap = yield* ssh.ensureEnvironment(target);
    return { bootstrap, seen, prepared };
  }).pipe(Effect.provide(layer), Effect.runPromise);
}

describe("withBoat", () => {
  it("connects a Boat VM by alias so a port saved before a resume cannot win", async () => {
    const { bootstrap, seen, prepared } = await run({
      alias: boatAlias,
      hostname: "198.51.100.4",
      username: "user",
      port: 19036,
    });
    expect(prepared).toEqual([boatAlias]);
    expect(seen).toEqual([{ alias: boatAlias, hostname: boatAlias, username: "user", port: null }]);
    expect(bootstrap.target).toEqual(stableBoatTarget(seen[0]!));
  });

  it("leaves ordinary SSH hosts untouched", async () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: 2222 };
    const { bootstrap, seen } = await run(target);
    expect(seen).toEqual([target]);
    expect(bootstrap.target).toEqual({ ...target, hostname: "203.0.113.10", port: 22001 });
  });
});
