import {
  DesktopBoatCreateVmInputSchema,
  DesktopBoatRemoveVmInputSchema,
  DesktopBoatSettingsSchema,
  DesktopBoatSettingsUpdateSchema,
  DesktopBoatVmSchema,
  DesktopBoatWakeVmInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBoatEnvironment from "../../boat/DesktopBoatEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getBoatSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_BOAT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: DesktopBoatSettingsSchema,
  handler: Effect.fn("desktop.ipc.boat.getSettings")(function* () {
    const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
    return yield* boat.getSettings;
  }),
});

export const updateBoatSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_BOAT_SETTINGS_CHANNEL,
  payload: DesktopBoatSettingsUpdateSchema,
  result: DesktopBoatSettingsSchema,
  handler: Effect.fn("desktop.ipc.boat.updateSettings")(function* (update) {
    const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
    return yield* boat.updateSettings(update);
  }),
});

export const createBoatVm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CREATE_BOAT_VM_CHANNEL,
  payload: DesktopBoatCreateVmInputSchema,
  result: DesktopBoatVmSchema,
  handler: Effect.fn("desktop.ipc.boat.createVm")(function* (input) {
    const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
    return yield* boat.createVm(input);
  }),
});

export const removeBoatVm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOVE_BOAT_VM_CHANNEL,
  payload: DesktopBoatRemoveVmInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.boat.removeVm")(function* ({ target, stop }) {
    const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
    yield* boat.removeVm(target, { stop });
  }),
});

export const wakeBoatVm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WAKE_BOAT_VM_CHANNEL,
  payload: DesktopBoatWakeVmInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.boat.wakeVm")(function* ({ target }) {
    const boat = yield* DesktopBoatEnvironment.DesktopBoatEnvironment;
    yield* boat.wakeVm(target);
  }),
});
