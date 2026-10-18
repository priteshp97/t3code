import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { SshLaunchError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopBoatEnvironment from "./DesktopBoatEnvironment.ts";
import { boatSandboxIdFromAlias } from "./boatSshConfig.ts";

/**
 * Boat hands out a new address and mapped port on resume, but the SSH path
 * persists the resolved target and lets a saved port override ssh_config. A Boat
 * target therefore always travels as its bare alias, and ssh_config supplies the
 * current address.
 */
export function stableBoatTarget(target: DesktopSshEnvironmentTarget): DesktopSshEnvironmentTarget {
  if (boatSandboxIdFromAlias(target.alias) === null) return target;
  return { alias: target.alias, hostname: target.alias, username: target.username, port: null };
}

/**
 * Decorates the SSH environment service so a Boat-backed target is resumed and
 * re-addressed before the normal SSH launch, install and tunnel path runs. Every
 * other target goes straight through.
 */
export const withBoat = <E, R>(
  inner: Layer.Layer<DesktopSshEnvironment.DesktopSshEnvironment, E, R>,
) =>
  Layer.effect(
    DesktopSshEnvironment.DesktopSshEnvironment,
    Effect.gen(function* () {
      const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
      return DesktopSshEnvironment.DesktopSshEnvironment.of({
        ...ssh,
        ensureEnvironment: (target, options) =>
          boat.prepareTarget(target).pipe(
            Effect.mapError(
              (cause) => new SshLaunchError({ message: cause.message, stdout: "", cause }),
            ),
            Effect.andThen(ssh.ensureEnvironment(stableBoatTarget(target), options)),
            Effect.map((bootstrap) =>
              boatSandboxIdFromAlias(target.alias) === null
                ? bootstrap
                : { ...bootstrap, target: stableBoatTarget(bootstrap.target) },
            ),
          ),
        disconnectEnvironment: (target) => ssh.disconnectEnvironment(stableBoatTarget(target)),
      });
    }),
  ).pipe(Layer.provide(inner));

/** `withBoat` plus the Boat service itself, which the Boat IPC handlers also use. */
export const layerWithBoat = <E, R>(
  inner: Layer.Layer<DesktopSshEnvironment.DesktopSshEnvironment, E, R>,
) => withBoat(inner).pipe(Layer.provideMerge(DesktopBoatEnvironment.layer));
