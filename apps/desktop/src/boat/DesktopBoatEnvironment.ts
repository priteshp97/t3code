// @effect-diagnostics nodeBuiltinImport:off - Boat VM bookkeeping is plain async I/O behind one service boundary.
// @effect-diagnostics globalTimers:off - Port-wait retries run inside plain promises.
// @effect-diagnostics globalDate:off - Port-wait deadlines run inside plain promises.
// @effect-diagnostics globalConsole:off - Helper install runs in a child-process callback outside any fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type {
  DesktopBoatCreateVmInput,
  DesktopBoatSettings,
  DesktopBoatSettingsUpdate,
  DesktopBoatVm,
  DesktopBoatVmDefaults,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { type BoatSshAccess, ensureBoatSandboxRunning, makeBoatClient } from "./boatApi.ts";
import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import { boatVmSetupScript } from "./boatKeepAwake.ts";
import {
  BOAT_SSH_DIR_NAME,
  boatAliasForSandbox,
  boatSandboxIdFromAlias,
  renderBoatKnownHosts,
  renderBoatSshConfig,
  withBoatSshInclude,
} from "./boatSshConfig.ts";

export class DesktopBoatEnvironmentError extends Schema.TaggedError<DesktopBoatEnvironmentError>()(
  "DesktopBoatEnvironmentError",
  { message: Schema.String },
) {}

export const DEFAULT_BOAT_VM_DEFAULTS: DesktopBoatVmDefaults = {
  snapshot: "t3code",
  environment: "",
  size: "default",
  idleMinutes: 15,
};

/**
 * A sleeping VM resumes only after the user asks for it (Reconnect on one of its
 * threads). Background reconnects would otherwise wake it the moment it slept.
 * The grant outlives one connect attempt so the supervisor's retries can use it.
 */
const WAKE_GRANT_MS = 3 * 60_000;
const SSH_PORT_WAIT_MS = 90_000;

interface StoredVm {
  readonly sandboxId: string;
  readonly label: string;
  readonly idleMinutes: number;
  readonly ssh: BoatSshAccess | null;
}

interface StoredState {
  readonly encryptedApiKey?: string;
  readonly defaults?: DesktopBoatVmDefaults;
  readonly vms?: readonly StoredVm[];
}

export class DesktopBoatEnvironment extends Context.Service<
  DesktopBoatEnvironment,
  {
    readonly getSettings: Effect.Effect<DesktopBoatSettings, DesktopBoatEnvironmentError>;
    readonly updateSettings: (
      update: DesktopBoatSettingsUpdate,
    ) => Effect.Effect<DesktopBoatSettings, DesktopBoatEnvironmentError>;
    readonly createVm: (
      input: DesktopBoatCreateVmInput,
    ) => Effect.Effect<DesktopBoatVm, DesktopBoatEnvironmentError>;
    /** Resumes a Boat-backed SSH target before T3 connects. Non-Boat targets pass through. */
    readonly prepareTarget: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopBoatEnvironmentError>;
    /** Lets the next connects resume this VM if it is asleep. */
    readonly wakeVm: (target: DesktopSshEnvironmentTarget) => Effect.Effect<void>;
    readonly removeVm: (
      target: DesktopSshEnvironmentTarget,
      options: { readonly stop: boolean },
    ) => Effect.Effect<void, DesktopBoatEnvironmentError>;
  }
>()("@t3tools/desktop/boat/DesktopBoatEnvironment") {}

const run = <A>(operation: string, promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) =>
      new DesktopBoatEnvironmentError({
        message: cause instanceof Error ? cause.message : `Boat ${operation} failed.`,
      }),
  }).pipe(Effect.withSpan(`desktop.boat.${operation}`));

function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempt = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect({ host, port, timeout: 5_000 });
      const fail = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Boat VM SSH at ${host}:${port} did not answer in time.`));
          return;
        }
        setTimeout(() => attempt().then(resolve, reject), 2_000);
      };
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", fail);
      socket.once("timeout", fail);
    });
  return attempt();
}

function sshKeygen(privateKeyPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "t3code-boat", "-f", privateKeyPath],
      { timeout: 30_000, windowsHide: true },
      (error) =>
        error
          ? reject(new Error(`Could not create the Boat SSH key with ssh-keygen: ${error.message}`))
          : resolve(),
    );
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const statePath = NodePath.join(environment.stateDir, "boat.json");
  const sshDir = NodePath.join(environment.homeDirectory, ".ssh");
  const boatSshDir = NodePath.join(sshDir, BOAT_SSH_DIR_NAME);
  const identityPath = NodePath.join(boatSshDir, "id_ed25519");
  const wakeGrants = new Map<string, number>();
  let stateLock: Promise<unknown> = Promise.resolve();

  const readState = async (): Promise<StoredState> => {
    try {
      return JSON.parse(await NodeFSP.readFile(statePath, "utf8")) as StoredState;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("The Boat settings file is unreadable.", { cause });
    }
  };

  /** Serializes read-modify-write so a keep-awake tick never races a create. */
  const updateState = <A>(change: (state: StoredState) => Promise<[StoredState, A]>) => {
    const next = stateLock.then(async () => {
      const [state, result] = await change(await readState());
      await NodeFSP.mkdir(environment.stateDir, { recursive: true });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await NodeFSP.rename(temporary, statePath);
      return result;
    });
    stateLock = next.catch(() => undefined);
    return next;
  };

  const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const readApiKey = async (state: StoredState): Promise<string> => {
    if (!state.encryptedApiKey) {
      throw new Error("Add your Boat API key in Settings → Connections → Boat.dev VM first.");
    }
    return runEffect(
      safeStorage.decryptString(Buffer.from(state.encryptedApiKey, "base64")).pipe(
        Effect.mapError(
          () =>
            new DesktopBoatEnvironmentError({
              message: "The saved Boat API key could not be decrypted.",
            }),
        ),
      ),
    );
  };

  const settingsView = (state: StoredState): DesktopBoatSettings => ({
    hasApiKey: Boolean(state.encryptedApiKey),
    defaults: state.defaults ?? DEFAULT_BOAT_VM_DEFAULTS,
  });

  const writeSshFiles = async (vms: readonly StoredVm[]) => {
    await NodeFSP.mkdir(boatSshDir, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(boatSshDir, "config"), renderBoatSshConfig(vms), {
      mode: 0o600,
    });
    await NodeFSP.writeFile(NodePath.join(boatSshDir, "known_hosts"), renderBoatKnownHosts(vms), {
      mode: 0o600,
    });
    const userConfigPath = NodePath.join(sshDir, "config");
    const existing = await NodeFSP.readFile(userConfigPath, "utf8").catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    const withInclude = withBoatSshInclude(existing);
    if (withInclude !== null) {
      await NodeFSP.writeFile(userConfigPath, withInclude, { mode: 0o600 });
    }
  };

  const ensureIdentity = async (): Promise<string> => {
    await NodeFSP.mkdir(boatSshDir, { recursive: true, mode: 0o700 });
    const publicKeyPath = `${identityPath}.pub`;
    const existing = await NodeFSP.readFile(publicKeyPath, "utf8").catch(() => null);
    if (existing !== null) return existing.trim();
    await sshKeygen(identityPath);
    return (await NodeFSP.readFile(publicKeyPath, "utf8")).trim();
  };

  // Fork builds point the CLI release repo at the fork, so this follows the app's own releases.
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("").replace(/\/v$/u, "");

  /**
   * Installs the T3 server service (this app's version) and the keep-awake helper.
   * Dev builds have no release archive, so the SSH path launches their server.
   */
  const setUpVm = (sandboxId: string, idleMinutes: number) =>
    new Promise<void>((resolve) => {
      const child = NodeChildProcess.spawn(
        "ssh",
        ["-T", "-o", "BatchMode=yes", boatAliasForSandbox(sandboxId), "bash -s"],
        { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, timeout: 120_000 },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        console.warn(`Boat VM services not set up on ${sandboxId}: ${error.message}`);
        resolve();
      });
      child.on("close", (code) => {
        // Without the services the SSH path still launches T3 and the VM still stops on its
        // idle timer; work just cannot outlive the app.
        if (code !== 0) {
          console.warn(`Boat VM services not set up on ${sandboxId}: ${stderr.trim()}`);
        }
        resolve();
      });
      child.stdin.end(
        boatVmSetupScript({
          graceSeconds: idleMinutes * 60,
          server: environment.isDevelopment
            ? null
            : { version: environment.appVersion, releaseBaseUrl },
        }),
      );
    });

  /** Starts the VM, registers our key and pins its current address and host key. */
  const bringUp = async (
    sandboxId: string,
    idleMinutes: number,
    apiKey: string,
    options: { readonly wake: boolean },
  ) => {
    const client = makeBoatClient({ apiKey });
    const current = await client.getSandbox(sandboxId);
    if (!options.wake && (current.state === "archived" || current.state === "archiving")) {
      throw new Error(
        "This Boat VM is asleep to save cost. Open one of its threads and choose Reconnect to wake it.",
      );
    }
    await ensureBoatSandboxRunning(client, sandboxId, idleMinutes * 60, { timeoutMs: 10 * 60_000 });
    const ssh = await client.configureSshKey(sandboxId, await ensureIdentity());
    await updateState(async (state) => {
      const vms = (state.vms ?? []).map((vm) => (vm.sandboxId === sandboxId ? { ...vm, ssh } : vm));
      await writeSshFiles(vms);
      return [{ ...state, vms }, undefined];
    });
    await waitForTcpPort(ssh.hostname, ssh.port, SSH_PORT_WAIT_MS);
    await setUpVm(sandboxId, idleMinutes);
    return ssh;
  };

  const targetFor = (sandboxId: string, ssh: BoatSshAccess): DesktopSshEnvironmentTarget => {
    const alias = boatAliasForSandbox(sandboxId);
    return { alias, hostname: alias, username: ssh.username, port: null };
  };

  return DesktopBoatEnvironment.of({
    getSettings: run("getSettings", async () => settingsView(await readState())),

    updateSettings: (update) =>
      run("updateSettings", async () => {
        let encryptedApiKey: string | null | undefined;
        if (typeof update.apiKey === "string") {
          const apiKey = update.apiKey.trim();
          if (!/^boat_[A-Za-z0-9_-]+$/u.test(apiKey)) {
            throw new Error("That does not look like a Boat API key (they start with boat_).");
          }
          const available = await runEffect(
            safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)),
          );
          if (!available) {
            throw new Error("Secure storage is unavailable, so the Boat API key cannot be saved.");
          }
          const encrypted = await runEffect(safeStorage.encryptString(apiKey));
          encryptedApiKey = Buffer.from(encrypted).toString("base64");
        } else if (update.apiKey === null) {
          encryptedApiKey = null;
        }
        return updateState(async (state) => {
          const { encryptedApiKey: previousKey, ...rest } = state;
          const keyToStore = encryptedApiKey === undefined ? previousKey : encryptedApiKey;
          const next: StoredState = {
            ...rest,
            ...(keyToStore ? { encryptedApiKey: keyToStore } : {}),
            ...(update.defaults ? { defaults: update.defaults } : {}),
          };
          return [next, settingsView(next)];
        });
      }),

    createVm: (input) =>
      run("createVm", async () => {
        const apiKey = await readApiKey(await readState());
        const { defaults } = input;
        const sandbox = await makeBoatClient({ apiKey }).createSandbox({
          size: defaults.size,
          ttlSeconds: defaults.idleMinutes * 60,
          idempotencyKey: NodeCrypto.randomUUID(),
          ...(defaults.environment.trim() ? { environment: defaults.environment.trim() } : {}),
          ...(defaults.snapshot.trim() ? { fromSnapshot: defaults.snapshot.trim() } : {}),
        });
        const label = input.label.trim() || `Boat ${sandbox.name ?? sandbox.id}`;
        // Record the VM before waiting on it so a failed start can still be found and removed.
        await updateState(async (state) => [
          {
            ...state,
            vms: [
              ...(state.vms ?? []),
              { sandboxId: sandbox.id, label, idleMinutes: defaults.idleMinutes, ssh: null },
            ],
          },
          undefined,
        ]);
        const ssh = await bringUp(sandbox.id, defaults.idleMinutes, apiKey, { wake: true });
        return { sandboxId: sandbox.id, label, target: targetFor(sandbox.id, ssh) };
      }),

    prepareTarget: (target) =>
      Effect.suspend(() => {
        const sandboxId = boatSandboxIdFromAlias(target.alias);
        if (sandboxId === null) return Effect.void;
        return run("prepareTarget", async () => {
          const state = await readState();
          const vm = state.vms?.find((entry) => entry.sandboxId === sandboxId);
          if (vm === undefined) {
            throw new Error(`Boat VM ${sandboxId} is not registered on this computer.`);
          }
          const apiKey = await readApiKey(state);
          const wake = (wakeGrants.get(sandboxId) ?? 0) > Date.now();
          await bringUp(sandboxId, vm.idleMinutes, apiKey, { wake });
          wakeGrants.delete(sandboxId);
        });
      }),

    wakeVm: (target) =>
      Effect.gen(function* () {
        const sandboxId = boatSandboxIdFromAlias(target.alias);
        if (sandboxId === null) return;
        wakeGrants.set(sandboxId, (yield* Clock.currentTimeMillis) + WAKE_GRANT_MS);
      }),

    removeVm: (target, options) =>
      Effect.suspend(() => {
        const sandboxId = boatSandboxIdFromAlias(target.alias);
        if (sandboxId === null) return Effect.void;
        return run("removeVm", async () => {
          wakeGrants.delete(sandboxId);
          const state = await readState();
          if (options.stop) {
            const client = makeBoatClient({ apiKey: await readApiKey(state) });
            const sandbox = await client.getSandbox(sandboxId).catch(() => null);
            if (sandbox && sandbox.state !== "archived" && sandbox.state !== "archiving") {
              await client.stopSandbox(sandboxId);
            }
          }
          await updateState(async (current) => {
            const vms = (current.vms ?? []).filter((vm) => vm.sandboxId !== sandboxId);
            await writeSshFiles(vms);
            return [{ ...current, vms }, undefined];
          });
        });
      }),
  });
});

export const layer = Layer.effect(DesktopBoatEnvironment, make);
