import { describe, expect, it } from "vite-plus/test";

import {
  BOAT_SSH_INCLUDE_LINE,
  boatAliasForSandbox,
  boatSandboxIdFromAlias,
  renderBoatKnownHosts,
  renderBoatSshConfig,
  withBoatSshInclude,
} from "./boatSshConfig.ts";

const ssh = {
  hostname: "203.0.113.10",
  port: 22001,
  username: "user",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoatHostKeyForTests",
};

describe("Boat SSH aliases", () => {
  it("round-trips a sandbox id and ignores ordinary hosts", () => {
    expect(boatSandboxIdFromAlias(boatAliasForSandbox("bx_abcd2345"))).toBe("bx_abcd2345");
    expect(boatSandboxIdFromAlias("devbox")).toBeNull();
    expect(boatSandboxIdFromAlias("t3-boat-../../etc")).toBeNull();
  });
});

describe("renderBoatSshConfig", () => {
  it("pins the host key by alias so a new address after resume keeps verifying", () => {
    const entries = [{ sandboxId: "bx_abcd2345", ssh }];
    const config = renderBoatSshConfig(entries);
    expect(config).toContain("Host t3-boat-bx_abcd2345\n  HostName 203.0.113.10\n  Port 22001");
    expect(config).toContain("HostKeyAlias t3-boat-bx_abcd2345");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(renderBoatKnownHosts(entries)).toBe(`t3-boat-bx_abcd2345 ${ssh.hostKey}\n`);
  });

  it("omits VMs that have not reported an address yet", () => {
    expect(renderBoatSshConfig([{ sandboxId: "bx_abcd2345", ssh: null }])).not.toContain("Host ");
  });
});

describe("withBoatSshInclude", () => {
  it("puts the include ahead of existing Host blocks", () => {
    expect(withBoatSshInclude("Host devbox\n  HostName 10.0.0.2\n")).toBe(
      `${BOAT_SSH_INCLUDE_LINE}\n\nHost devbox\n  HostName 10.0.0.2\n`,
    );
  });

  it("creates a config and leaves one that already includes it untouched", () => {
    expect(withBoatSshInclude(null)).toBe(`${BOAT_SSH_INCLUDE_LINE}\n`);
    expect(withBoatSshInclude(`${BOAT_SSH_INCLUDE_LINE}\r\nHost a\r\n`)).toBeNull();
  });

  it("keeps Windows line endings", () => {
    expect(withBoatSshInclude("Host a\r\n")).toBe(`${BOAT_SSH_INCLUDE_LINE}\r\n\r\nHost a\r\n`);
  });
});
