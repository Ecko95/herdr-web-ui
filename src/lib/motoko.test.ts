import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import { readFileSync } from "node:fs";
import { ceremonyCanceled, enrollFirstPasskey, fetchMotokoRequests, ownerErrorMessage, ownerMode, ownerSignOut, submitMotokoRequest } from "./motoko.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("owner mode", () => {
  it("is on only when health says the owner gate runs", () => {
    expect(ownerMode(null)).toBe(false);
    expect(ownerMode({ required: false, authenticated: true, via: "device" })).toBe(false);
    expect(ownerMode({ required: true, authenticated: false, reason: "token_required" })).toBe(false);
    expect(ownerMode({ required: true, authenticated: false, reason: "owner_required" as never, owner: { enrolled: true } })).toBe(true);
    expect(ownerMode({ required: false, authenticated: true, via: "owner" as never })).toBe(true);
  });
});

describe("owner errors", () => {
  it("names each server refusal and never echoes an unknown code's internals as a code", () => {
    expect(ownerErrorMessage(new ApiError("/api/owner/sign-in", 400, "x", "invalid_challenge"))).toContain("Try again");
    expect(ownerErrorMessage(new ApiError("/api/owner/register", 409, "x", "duplicate_credential"))).toContain("already registered");
    expect(ownerErrorMessage(new ApiError("/api/owner/x", 503, "raw", "something_new"))).toContain("Nothing changed");
    expect(ownerErrorMessage(new ApiError("/api/owner/x", 400, "server words", null))).toBe("server words");
  });

  it("tells a closed prompt from a failure, and an authenticator that cannot keep a discoverable passkey", () => {
    const closed = Object.assign(new Error("closed"), { name: "NotAllowedError" });
    expect(ceremonyCanceled(closed)).toBe(true);
    expect(ceremonyCanceled(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(ceremonyCanceled(new ApiError("/x", 400, "x", "invalid_challenge"))).toBe(false);
    const constraint = Object.assign(new Error("x"), { name: "ConstraintError", code: "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT" });
    expect(ownerErrorMessage(constraint)).toContain("cannot keep a passkey");
  });
});

describe("owner requests", () => {
  it("signs out on the server with the app's mutation header", async () => {
    const seen: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(new URL(String(input), "http://x"), init)); return new Response(null, { status: 204 }); }) as typeof fetch;
    await ownerSignOut();
    expect(seen[0]!.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/api/owner/sign-out");
    expect(seen[0]!.headers.get("x-herdr-machine")).toBe("1");
  });

  it("sends the enrollment token once and does not retry after a refusal", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return Response.json({ error: { code: "enrollment_required", message: "no" } }, { status: 401 }); }) as unknown as typeof fetch;
    const failure = await enrollFirstPasskey("one-time", "Laptop").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("enrollment_required");
    expect(calls).toBe(1);
  });
});

describe("Motoko requests", () => {
  const ID = "0b7f4a5c-1d2e-4f60-8a9b-0c1d2e3f4a5b";
  it("posts exactly requestId and text once, and does not retry an unconfirmed answer", async () => {
    const seen: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(new URL(String(input), "http://x"), init)); return new Response("gateway down", { status: 502 }); }) as typeof fetch;
    const failure = await submitMotokoRequest({ requestId: ID, text: "Plan <b>the</b> trip" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(seen.length).toBe(1);
    expect(seen[0]!.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/api/motoko/requests");
    expect(seen[0]!.headers.get("x-herdr-machine")).toBe("1");
    expect(await seen[0]!.text()).toBe(JSON.stringify({ requestId: ID, text: "Plan <b>the</b> trip" }));
  });

  it("reads the history with GET only and keeps nothing in browser storage", async () => {
    const seen: Request[] = [];
    const history = { enabled: true, requests: [], sampledAt: "2026-10-18T00:00:00.000Z" };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(new URL(String(input), "http://x"), init)); return Response.json(history); }) as typeof fetch;
    expect(await fetchMotokoRequests()).toEqual(history);
    expect(seen.map(r => [r.method, new URL(r.url).pathname])).toEqual([["GET", "/api/motoko/requests"]]);
    expect(readFileSync(new URL("./motoko.ts", import.meta.url), "utf8")).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it("names the coordination refusals", () => {
    expect(ownerErrorMessage(new ApiError("/api/motoko/requests", 409, "x", "coordination_origin_unbound"))).toContain("not connected");
    expect(ownerErrorMessage(new ApiError("/api/motoko/requests", 409, "x", "identifier_conflict"))).toContain("different text");
    expect(ownerErrorMessage(new ApiError("/api/motoko/requests", 409, "x", "history_full"))).toContain("100");
    expect(ownerErrorMessage(new ApiError("/api/motoko/requests", 400, "x", "invalid_request"))).toContain("4096");
  });
});
