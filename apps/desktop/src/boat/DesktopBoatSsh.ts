import { SshLaunchError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopBoatEnvironment from "./DesktopBoatEnvironment.ts";

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
            Effect.andThen(ssh.ensureEnvironment(target, options)),
          ),
        disconnectEnvironment: (target) =>
          ssh.disconnectEnvironment(target).pipe(Effect.ensuring(boat.releaseTarget(target))),
      });
    }),
  ).pipe(Layer.provide(inner), Layer.provideMerge(DesktopBoatEnvironment.layer));
