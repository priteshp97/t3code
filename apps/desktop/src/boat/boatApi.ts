// @effect-diagnostics globalTimers:off - Promise-based HTTP adapter, called from the Boat service boundary.
// @effect-diagnostics globalDate:off - Same adapter; start deadlines are wall-clock.
import * as NodeNet from "node:net";

export const BOAT_API_BASE_URL = "https://boat.dev/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_ID_PATTERN = /^bx_[a-z0-9]+$/u;

export type BoatSandboxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

export type BoatSandboxSize = "small" | "default" | "large" | "xlarge";

export interface BoatSandbox {
  readonly id: string;
  readonly name: string | null;
  readonly state: BoatSandboxState | string;
  readonly archiveAfter: string | null;
  readonly setupStatus: string | null;
  readonly setupError: string | null;
}

export interface BoatSshAccess {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly hostKey: string;
}

export class BoatApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, input: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = "BoatApiError";
    this.status = input.status ?? null;
    this.code = input.code ?? null;
  }
}

export function isBoatSandboxId(value: string): boolean {
  return SANDBOX_ID_PATTERN.test(value);
}

export function isBoatSandboxRunning(state: string): boolean {
  return state === "ready" || state === "idle" || state === "running";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseBoatSandbox(value: unknown): BoatSandbox {
  const record = (value ?? {}) as Record<string, unknown>;
  const id = readString(record.id);
  if (id === null || !isBoatSandboxId(id)) {
    throw new BoatApiError("Boat returned a sandbox without a valid id.");
  }
  return {
    id,
    name: readString(record.name),
    state: readString(record.state) ?? "init",
    archiveAfter: readString(record.archiveAfter),
    setupStatus: readString(record.setupStatus),
    setupError: readString(record.setupError),
  };
}

/**
 * Boat answers with either a dedicated public IP (port 22) or, on shared hosts,
 * a mapped `host:port`. The host key comes from the authenticated API, so it is
 * pinned instead of trusted on first use.
 */
export function parseBoatSshAccess(value: unknown): BoatSshAccess {
  const record = (value ?? {}) as Record<string, unknown>;
  const endpoint =
    readString(record.sshEndpoint) ??
    (NodeNet.isIP(String(record.machineIp ?? "")) === 4 ? `${String(record.machineIp)}:22` : null);
  const match = endpoint === null ? null : /^(\d+\.\d+\.\d+\.\d+):(\d+)$/u.exec(endpoint);
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || NodeNet.isIP(match[1]!) !== 4 || !(port >= 1 && port <= 65_535)) {
    throw new BoatApiError("Boat did not return a usable SSH endpoint.");
  }
  const username = readString(record.sshUser) ?? "user";
  if (!/^[a-z_][a-z0-9_-]*$/u.test(username)) {
    throw new BoatApiError("Boat returned an invalid SSH user.");
  }
  const hostKey = String(record.hostKey ?? "").trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(hostKey)) {
    throw new BoatApiError("Boat did not return a valid SSH host key to pin.");
  }
  return { hostname: match[1]!, port, username, hostKey };
}

export interface BoatClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BoatCreateSandboxInput {
  readonly size: BoatSandboxSize;
  readonly ttlSeconds: number;
  readonly environment?: string;
  readonly fromSnapshot?: string;
  readonly idempotencyKey: string;
}

export function makeBoatClient(options: BoatClientOptions) {
  const baseUrl = options.baseUrl ?? BOAT_API_BASE_URL;
  const doFetch = options.fetch ?? globalThis.fetch;

  const request = async (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const method = init.method ?? "GET";
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (cause) {
      throw new BoatApiError(
        `Could not reach Boat (${method} ${path}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = readString(payload.code);
      // Error envelopes never echo the bearer token, so their message is safe to surface.
      const detail = readString(payload.message) ?? readString(payload.error) ?? code;
      throw new BoatApiError(
        response.status === 401
          ? "Boat rejected the API key. Check it in the Boat VM settings."
          : `Boat ${method} ${path} failed (${response.status}${detail ? `: ${detail}` : ""}).`,
        { status: response.status, code },
      );
    }
    return payload;
  };

  const sandboxPath = (sandboxId: string) => {
    if (!isBoatSandboxId(sandboxId)) {
      throw new BoatApiError(`Invalid Boat sandbox id: ${sandboxId}`);
    }
    return `/sandboxes/${sandboxId}`;
  };

  return {
    createSandbox: async (input: BoatCreateSandboxInput, signal?: AbortSignal) => {
      const payload = await request("/sandboxes", {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: {
          type: input.size,
          ttlSeconds: input.ttlSeconds,
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.fromSnapshot ? { from: input.fromSnapshot } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      return parseBoatSandbox(payload.sandbox);
    },
    getSandbox: async (sandboxId: string, signal?: AbortSignal) =>
      parseBoatSandbox((await request(sandboxPath(sandboxId), signal ? { signal } : {})).sandbox),
    resumeSandbox: async (sandboxId: string, ttlSeconds: number, signal?: AbortSignal) => {
      await request(`${sandboxPath(sandboxId)}/resume`, {
        method: "POST",
        body: { ttlSeconds },
        ...(signal ? { signal } : {}),
      });
    },
    setTtl: async (sandboxId: string, ttlSeconds: number, signal?: AbortSignal) => {
      await request(sandboxPath(sandboxId), {
        method: "PATCH",
        body: { ttlSeconds },
        ...(signal ? { signal } : {}),
      });
    },
    stopSandbox: async (sandboxId: string, signal?: AbortSignal) => {
      await request(`${sandboxPath(sandboxId)}/stop`, {
        method: "POST",
        body: {},
        ...(signal ? { signal } : {}),
      });
    },
    configureSshKey: async (sandboxId: string, publicKey: string, signal?: AbortSignal) =>
      parseBoatSshAccess(
        await request(`${sandboxPath(sandboxId)}/sshkey`, {
          method: "POST",
          body: { key: publicKey },
          ...(signal ? { signal } : {}),
        }),
      ),
  };
}

export type BoatClient = ReturnType<typeof makeBoatClient>;

export interface WaitForRunningOptions {
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Brings a sandbox to a running state: waits out an in-flight archive (a stop
 * timer may be firing right now), resumes an archived sandbox, and otherwise
 * refreshes its auto-stop timer.
 */
export async function ensureBoatSandboxRunning(
  client: BoatClient,
  sandboxId: string,
  ttlSeconds: number,
  options: WaitForRunningOptions = {},
): Promise<BoatSandbox> {
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  const sleep = options.sleep ?? defaultSleep;
  let resumed = false;
  for (;;) {
    options.signal?.throwIfAborted();
    const sandbox = await client.getSandbox(sandboxId, options.signal);
    if (isBoatSandboxRunning(sandbox.state)) {
      if (!resumed) await client.setTtl(sandboxId, ttlSeconds, options.signal);
      return sandbox;
    }
    if (sandbox.state === "error" || sandbox.state === "cancelled") {
      throw new BoatApiError(
        `Boat VM ${sandboxId} is unavailable (${sandbox.state}${sandbox.setupError ? `: ${sandbox.setupError}` : ""}).`,
      );
    }
    if (sandbox.state === "archived" && !resumed) {
      await client.resumeSandbox(sandboxId, ttlSeconds, options.signal);
      resumed = true;
    }
    if (Date.now() >= deadline) {
      throw new BoatApiError(
        `Boat VM ${sandboxId} did not start in time (last state: ${sandbox.state}).`,
      );
    }
    await sleep(pollMs, options.signal);
  }
}
