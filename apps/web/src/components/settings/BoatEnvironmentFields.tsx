import type {
  DesktopBoatSandboxSize,
  DesktopBoatSettings,
  DesktopBoatVm,
  DesktopBoatVmDefaults,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { EnvironmentPresentation } from "~/state/environments";

const SIZE_LABELS: Record<DesktopBoatSandboxSize, string> = {
  small: "Small · 2 vCPU / 4 GB",
  default: "Default · 4 vCPU / 8 GB",
  large: "Large · 8 vCPU / 16 GB",
  xlarge: "X-large · 16 vCPU / 32 GB",
};
const SIZES = Object.keys(SIZE_LABELS) as DesktopBoatSandboxSize[];

export function isBoatVmSupported(): boolean {
  return typeof window.desktopBridge?.createBoatVm === "function";
}

/** The SSH target of a Boat-backed saved environment, or null for anything else. */
export function boatSshTargetOf(
  environment: EnvironmentPresentation,
): DesktopSshEnvironmentTarget | null {
  const profile = Option.getOrUndefined(environment.entry.profile);
  if (profile?._tag !== "SshConnectionProfile") return null;
  return profile.target.alias.startsWith("t3-boat-bx_") ? profile.target : null;
}

/** Stops the VM behind a removed environment. Boat deletes a stopped VM's disk after 14 days. */
export async function stopBoatVmFor(environment: EnvironmentPresentation): Promise<void> {
  const target = boatSshTargetOf(environment);
  if (target === null) return;
  await window.desktopBridge?.removeBoatVm?.({ target, stop: true });
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  // Electron prefixes rejected IPC calls with the channel name.
  return error.message.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/u, "");
}

export function BoatEnvironmentFields(props: {
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onCreated: (vm: DesktopBoatVm) => Promise<void>;
}) {
  const bridge = window.desktopBridge;
  const [settings, setSettings] = useState<DesktopBoatSettings | null>(null);
  const [defaults, setDefaults] = useState<DesktopBoatVmDefaults | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [label, setLabel] = useState("");
  const [idleMinutes, setIdleMinutes] = useState("");
  const [busy, setBusy] = useState<"saving-key" | "creating" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bridge
      ?.getBoatSettings?.()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setDefaults(loaded.defaults);
        setIdleMinutes(String(loaded.defaults.idleMinutes));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause, "Could not load Boat settings."));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const needsKey = settings !== null && (!settings.hasApiKey || editingKey);
  const disabled = props.disabled || busy !== null || settings === null || defaults === null;

  const saveKey = async () => {
    if (!bridge?.updateBoatSettings) return;
    setBusy("saving-key");
    setError(null);
    try {
      setSettings(await bridge.updateBoatSettings({ apiKey }));
      setApiKey("");
      setEditingKey(false);
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the Boat API key."));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!bridge?.createBoatVm || !bridge.updateBoatSettings || defaults === null) return;
    const minutes = Number.parseInt(idleMinutes, 10);
    if (!(minutes >= 10 && minutes <= 1440)) {
      setError("Stop after idle must be between 10 and 1440 minutes.");
      return;
    }
    const chosen = { ...defaults, idleMinutes: minutes };
    setBusy("creating");
    setError(null);
    try {
      await bridge.updateBoatSettings({ defaults: chosen });
      const vm = await bridge.createBoatVm({ label, defaults: chosen });
      setLabel("");
      await props.onCreated(vm);
    } catch (cause) {
      setError(errorMessage(cause, "Could not start the Boat VM."));
    } finally {
      setBusy(null);
    }
  };

  const shownError = error ?? props.error;

  if (needsKey) {
    return (
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Boat API key</span>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="boat_…"
            disabled={busy !== null}
            spellCheck={false}
          />
          <span className="mt-1.5 block text-xs text-muted-foreground">
            Create a key at boat.dev with sandbox create, read, update, stop, resume and SSH access.
            It is stored encrypted on this computer only.
          </span>
        </label>
        {shownError ? (
          <Alert variant="error">
            <AlertDescription>{shownError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex gap-2">
          {settings?.hasApiKey ? (
            <Button variant="ghost" onClick={() => setEditingKey(false)}>
              Cancel
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy !== null || apiKey.trim().length === 0}
            onClick={() => void saveKey()}
          >
            {busy === "saving-key" ? "Saving…" : "Save key"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Project name, e.g. LeadFlow"
            disabled={disabled}
          />
        </label>
        <div className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Size</span>
          <Select
            value={defaults?.size ?? "default"}
            onValueChange={(value) => {
              if (defaults && SIZES.includes(value as DesktopBoatSandboxSize)) {
                setDefaults({ ...defaults, size: value as DesktopBoatSandboxSize });
              }
            }}
          >
            <SelectTrigger aria-label="Boat VM size" disabled={disabled}>
              <SelectValue>{(value: DesktopBoatSandboxSize) => SIZE_LABELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {SIZES.map((size) => (
                <SelectItem key={size} value={size}>
                  {SIZE_LABELS[size]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Setup snapshot</span>
          <Input
            value={defaults?.snapshot ?? ""}
            onChange={(event) =>
              defaults && setDefaults({ ...defaults, snapshot: event.target.value })
            }
            placeholder="Boat base image"
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Boat environment</span>
          <Input
            value={defaults?.environment ?? ""}
            onChange={(event) =>
              defaults && setDefaults({ ...defaults, environment: event.target.value })
            }
            placeholder="Account default"
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Stop after idle (minutes)
          </span>
          <Input
            value={idleMinutes}
            onChange={(event) => setIdleMinutes(event.target.value)}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        T3 Code keeps the VM awake while this app is connected to it. It stops on its own once the
        app has been closed or disconnected for the idle time, and resumes when you reconnect.
      </p>
      {shownError ? (
        <Alert variant="error">
          <AlertDescription>{shownError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button variant="ghost" disabled={disabled} onClick={() => setEditingKey(true)}>
          Change API key
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          disabled={disabled}
          onClick={() => void create()}
        >
          <CloudIcon className="size-3.5" />
          {busy === "creating" || props.disabled ? "Starting VM…" : "Create Boat VM"}
        </Button>
      </div>
    </div>
  );
}
