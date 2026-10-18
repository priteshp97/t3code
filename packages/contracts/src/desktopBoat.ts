import * as Schema from "effect/Schema";

import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";

export const DesktopBoatSandboxSizeSchema = Schema.Literals([
  "small",
  "default",
  "large",
  "xlarge",
]);
export type DesktopBoatSandboxSize = typeof DesktopBoatSandboxSizeSchema.Type;

export const DesktopBoatVmDefaultsSchema = Schema.Struct({
  /** Named Boat snapshot holding the coding setup; empty uses Boat's base image. */
  snapshot: Schema.String,
  /** Boat environment (repositories, secrets, agent sign-ins); empty uses the account default. */
  environment: Schema.String,
  size: DesktopBoatSandboxSizeSchema,
  /** The VM stops this long after the desktop app last kept it awake. */
  idleMinutes: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 1440 })),
});
export type DesktopBoatVmDefaults = typeof DesktopBoatVmDefaultsSchema.Type;

export const DesktopBoatSettingsSchema = Schema.Struct({
  hasApiKey: Schema.Boolean,
  defaults: DesktopBoatVmDefaultsSchema,
});
export type DesktopBoatSettings = typeof DesktopBoatSettingsSchema.Type;

export const DesktopBoatSettingsUpdateSchema = Schema.Struct({
  /** A new key replaces the stored one; null forgets it; omitted keeps it. */
  apiKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  defaults: Schema.optionalKey(DesktopBoatVmDefaultsSchema),
});
export type DesktopBoatSettingsUpdate = typeof DesktopBoatSettingsUpdateSchema.Type;

export const DesktopBoatCreateVmInputSchema = Schema.Struct({
  label: Schema.String,
  defaults: DesktopBoatVmDefaultsSchema,
});
export type DesktopBoatCreateVmInput = typeof DesktopBoatCreateVmInputSchema.Type;

export const DesktopBoatVmSchema = Schema.Struct({
  sandboxId: Schema.String,
  label: Schema.String,
  target: DesktopSshEnvironmentTargetSchema,
});
export type DesktopBoatVm = typeof DesktopBoatVmSchema.Type;

export const DesktopBoatRemoveVmInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  stop: Schema.Boolean,
});
export type DesktopBoatRemoveVmInput = typeof DesktopBoatRemoveVmInputSchema.Type;
