import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { OwnerAuth } from "./motoko.ts";
import { useMotokoNavigation } from "./useMotokoNavigation.ts";

const owner: OwnerAuth = { required: true, authenticated: true, via: "owner" };
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeEach(() => Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }));
let renderer: ReactTestRenderer | undefined;
let navigation: ReturnType<typeof useMotokoNavigation>;
async function mount(auth: OwnerAuth | null, initial = false) {
  function Probe() { navigation = useMotokoNavigation(auth, initial); return null; }
  await act(async () => { renderer = create(createElement(Probe)); });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  if (actDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actDescriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("offers no action outside an authenticated owner session", async () => {
  for (const auth of [null, { required: false, authenticated: true, via: "local" } as OwnerAuth, { ...owner, authenticated: false }]) {
    await mount(auth);
    expect(navigation.open).toBeNull();
    await act(async () => renderer?.unmount());
  }
});

it("opens each destination and repeats a focus request", async () => {
  await mount(owner);
  expect(navigation.request).toBeNull();
  for (const destination of ["boot", "status", "map", "health", "requests", "sessions", "passkey"] as const) {
    await act(async () => navigation.open!(destination));
    expect(navigation.request?.destination).toBe(destination);
  }
  const before = navigation.request;
  await act(async () => navigation.open!("passkey"));
  expect(navigation.request).not.toBe(before);
  await act(async () => navigation.close());
  expect(navigation.request).toBeNull();
});

it("restores the Motoko page in Back and Forward without a pane", async () => {
  await mount(owner, true);
  expect(navigation.request?.destination).toBe("boot");
  await act(async () => navigation.restore(null));
  expect(navigation.request).toBeNull();
  await act(async () => navigation.restore("motoko"));
  expect(navigation.request?.destination).toBe("boot");
});
