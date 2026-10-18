import { expect, it } from "bun:test";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import type { OwnerStore } from "../motoko-owner.ts";
import type { DeviceStore } from "../devices.ts";
import type { MachineRelay } from "../machine-relay.ts";
import type { PendingInputs } from "../pending-input.ts";
import { type Client, connectionData, connectionOf, createConnections, send } from "./connections.ts";

function harness({ deviceId, readOnly = false, relay, revokedAlready = false, owner, ownerSessionId }: { deviceId?: string; readOnly?: boolean; relay?: MachineRelay; revokedAlready?: boolean; owner?: OwnerStore; ownerSessionId?: string } = {}) {
  const log: string[] = [];
  const revocations: (() => void)[] = [];
  const devices = {
    onRevoke: (_id: string, close: () => void) => {
      if (revokedAlready) close(); else revocations.push(close);
      return () => log.push("unwatch device");
    },
  } as unknown as DeviceStore;
  const pending = { close: () => log.push("pending closed") } as unknown as PendingInputs<Client, never>;
  const client = {
    data: connectionData({ deviceId, readOnly, ownerSessionId, ...(relay ? { relay } : {}) }),
    close: (code: number, reason: string) => log.push(`closed ${code} ${reason}`),
    getBufferedAmount: () => 0,
    send: () => 1,
  } as unknown as Client;
  const clients = new Set<Client>([client]);
  const present = new Set<Client>([client]);
  const connections = createConnections({
    clients, present, pending, devices, owner,
    detachClaimed: () => log.push("detach claimed"),
    dropClaims: () => log.push("drop claims"),
  });
  return { client, clients, present, log, revoke: () => revocations.forEach((close) => close()), ...connections };
}

it("a stall ends the connection once and leaves its presence to the socket's close", () => {
  const { client, clients, present, log, end } = harness();
  end(client, "stalled");
  end(client, "stalled");
  expect(log).toEqual(["pending closed", "detach claimed", "drop claims", `closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output consumer stalled`]);
  expect(clients.has(client)).toBe(false);
  expect(present.has(client)).toBe(true);
  expect(send(client, { type: "session-changed" })).toBe(0);
  end(client, "closed");
  expect(present.has(client)).toBe(false);
});

it("a revoke ends the connection with 1008 and leaves its pending input to the socket's close", () => {
  const { client, clients, present, log, admit, revoke, end, mayType, authorizeSocket } = harness({ deviceId: "phone" });
  expect(admit(client)).toBe(true);
  expect(mayType(client)).toBe(true);
  revoke();
  expect(log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
  expect(clients.has(client) || present.has(client)).toBe(false);
  expect(mayType(client)).toBe(false);
  expect(() => authorizeSocket(client)).toThrow("this device's access was revoked");
  end(client, "closed");
  expect(log.slice(3)).toEqual(["unwatch device", "pending closed", "detach claimed", "drop claims"]);
});

it("does not admit a device that was revoked before its socket opened", () => {
  const { client, log, admit } = harness({ deviceId: "phone", revokedAlready: true });
  expect(admit(client)).toBe(false);
  expect(log.at(-1)).toBe("closed 1008 Device access revoked");
});

it("closes only the relay of a relayed connection", () => {
  const relayed: string[] = [];
  const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
  const { client, present, log, end } = harness({ relay });
  end(client, "closed");
  expect(relayed).toEqual(["relay closed"]);
  expect(log).toEqual([]);
  expect(present.has(client)).toBe(false);
});

it("counts each change of role, and a read-only connection only watches", () => {
  const { client, setRole, mayType } = harness();
  setRole(client, "interact");
  expect(connectionOf(client).roles).toBe(0);
  setRole(client, "observe");
  setRole(client, "interact");
  expect(connectionOf(client)).toMatchObject({ mode: "interact", roles: 2 });
  expect(mayType(client)).toBe(true);
  const watcher = harness({ readOnly: true });
  expect(connectionOf(watcher.client).mode).toBe("observe");
  expect(() => watcher.authorizeSocket(watcher.client)).toThrow("this connection can only watch");
});

it("owner expiry refuses queued writes and revocation uses upstream teardown", () => {
  let valid = true, revoke = () => {};
  const owner = {
    current: () => valid ? { id: "fiction-owner" } : null,
    onRevoke: (_id: string, close: () => void) => { revoke = close; return () => {}; },
  } as unknown as OwnerStore;
  const { client, clients, present, admit, mayType, authorizeSocket, end } = harness({ owner, ownerSessionId: "fiction-owner" });
  expect(admit(client)).toBe(true);
  expect(mayType(client)).toBe(true);
  valid = false;
  expect(mayType(client)).toBe(false);
  expect(() => authorizeSocket(client)).toThrow("Owner access revoked");
  revoke();
  expect(clients.has(client) || present.has(client)).toBe(false);
  expect(connectionOf(client).closing).toBe(true);
  end(client, "closed");
});
