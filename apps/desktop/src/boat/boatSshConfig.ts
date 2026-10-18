import type { BoatSshAccess } from "./boatApi.ts";

/**
 * Boat VMs reach the existing SSH environment path through an ssh_config Host
 * alias. The alias stays stable while Boat hands out a new address on every
 * resume, and `HostKeyAlias` keeps the pinned host key keyed by the alias too.
 */
export const BOAT_SSH_DIR_NAME = "t3code-boat";
export const BOAT_SSH_INCLUDE_LINE = `Include ${BOAT_SSH_DIR_NAME}/config`;
const ALIAS_PREFIX = "t3-boat-";

export function boatAliasForSandbox(sandboxId: string): string {
  return `${ALIAS_PREFIX}${sandboxId}`;
}

export function boatSandboxIdFromAlias(alias: string): string | null {
  const trimmed = alias.trim();
  if (!trimmed.startsWith(ALIAS_PREFIX)) return null;
  const sandboxId = trimmed.slice(ALIAS_PREFIX.length);
  return /^bx_[a-z0-9]+$/u.test(sandboxId) ? sandboxId : null;
}

export interface BoatSshHostEntry {
  readonly sandboxId: string;
  readonly ssh: BoatSshAccess | null;
}

export function renderBoatSshConfig(entries: readonly BoatSshHostEntry[]): string {
  const blocks = entries.flatMap((entry) => {
    if (entry.ssh === null) return [];
    const alias = boatAliasForSandbox(entry.sandboxId);
    return [
      [
        `Host ${alias}`,
        `  HostName ${entry.ssh.hostname}`,
        `  Port ${entry.ssh.port}`,
        `  User ${entry.ssh.username}`,
        `  IdentityFile ~/.ssh/${BOAT_SSH_DIR_NAME}/id_ed25519`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ~/.ssh/${BOAT_SSH_DIR_NAME}/known_hosts`,
        `  HostKeyAlias ${alias}`,
        "  StrictHostKeyChecking yes",
        "  ForwardAgent no",
        "  ServerAliveInterval 15",
        "  ServerAliveCountMax 4",
      ].join("\n"),
    ];
  });
  return ["# Managed by T3 Code for Boat.dev VMs. Edits are overwritten.", ...blocks, ""].join(
    "\n\n",
  );
}

export function renderBoatKnownHosts(entries: readonly BoatSshHostEntry[]): string {
  return entries
    .flatMap((entry) =>
      entry.ssh === null ? [] : [`${boatAliasForSandbox(entry.sandboxId)} ${entry.ssh.hostKey}`],
    )
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * Returns the user's ssh_config with our Include as its first line, or null when
 * it is already present. An Include placed after a `Host` block would only apply
 * inside that block, so it must lead the file.
 */
export function withBoatSshInclude(existing: string | null): string | null {
  const content = existing ?? "";
  const lines = content.split(/\r?\n/u);
  if (lines.some((line) => line.trim() === BOAT_SSH_INCLUDE_LINE)) return null;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return content.length === 0
    ? `${BOAT_SSH_INCLUDE_LINE}${eol}`
    : `${BOAT_SSH_INCLUDE_LINE}${eol}${eol}${content}`;
}
