import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { Motoko } from "./Motoko.tsx";
import type { MotokoRequest } from "../lib/actions.ts";

let renderer: ReactTestRenderer | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let focused: string[];
let requests: { url: string; method: string }[];
const sessions = { credentials: [], sessions: [{ id: "fictional-session", credential_id: "fictional-key", created_at: "2026-01-01T00:00:00Z", last_active_at: "2026-01-01T00:00:00Z", observed_ip: null, user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", current: true }] };
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  focused = []; requests = [];
  for (const key of ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    return String(url) === "/api/owner/sessions" ? Response.json(sessions) : new Response("unexpected test read", { status: 503 });
  }, { preconnect: globalThis.fetch.preconnect }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  fetchSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});
const view = (request: MotokoRequest) => <SettingsProvider><Motoko auth={{ required: true, authenticated: true, via: "owner" }} request={request} onClose={() => {}} onSignOut={async () => {}} onSessionEnded={() => {}} /></SettingsProvider>;
async function open(request: MotokoRequest) {
  await act(async () => { renderer = create(view(request), { createNodeMock: (element) => {
    const props = element.props as { id?: string; children?: unknown };
    return { focus: () => focused.push(props.id ?? (props.children === "Sessions" ? "sessions" : "heading")), scrollIntoView() {} };
  } }); });
}

it("focuses the real session list and shows the current device", async () => {
  await open({ destination: "sessions" });
  expect(focused.at(-1)).toBe("sessions");
  const text = JSON.stringify(renderer!.toJSON());
  expect(text).toContain("Windows · Chrome");
  expect(text).toContain("this browser");
  expect(requests).toEqual([{ url: "/api/owner/sessions", method: "GET" }]);
});

it("focuses the passkey form on every request without a ceremony", async () => {
  await open({ destination: "passkey" });
  expect(focused.at(-1)).toBe("motoko-passkey-label");
  focused.length = 0;
  await act(async () => renderer!.update(view({ destination: "passkey" })));
  expect(focused).toEqual(["motoko-passkey-label"]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(requests.every((request) => request.url === "/api/owner/sessions")).toBe(true);
});

it("opens the map destination through the owner page",async()=>{
 await open({destination:"map"});
 expect(requests).toContainEqual({url:"/api/motoko/map/rigs",method:"GET"});
 expect(JSON.stringify(renderer!.toJSON())).toContain("Map");
});

it("opens the actual chat destination",async()=>{await open({destination:"chat"});expect(requests).toContainEqual({url:"/api/motoko/chat",method:"POST"});});
