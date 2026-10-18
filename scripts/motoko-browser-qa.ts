import { motokoTarget } from "../server/motoko-config.ts";
import { SOURCE, ORCHESTRATOR, RIG_ID, ENV } from "../server/fixtures/motoko-target.ts";
/**
 * Motoko in a real browser, against a disposable server: run it only through the controlled
 * runner, which gives it a temporary home, config and herdr session (scripts/motoko-env.ts):
 *
 *   bun run build
 *   HERDR_TEST_MODE=integration bun scripts/motoko-env.ts bun scripts/motoko-browser-qa.ts --stage=render --out=<dir>
 *   HERDR_TEST_MODE=integration bun scripts/motoko-env.ts bun scripts/motoko-browser-qa.ts --stage=owner --out=<dir>
 *
 * `render` needs no owner gate: the browser's /api/health and Motoko reads are answered from the
 * fixtures (page.route), the rest by the real synthetic server. It shows the views and their
 * states. It is not a proof of sign-in.
 *
 * `owner` needs the server's owner gate (server/motoko-owner.ts): a Chromium virtual
 * authenticator enrolls the first passkey with the one-time token, proves it, reaches the local
 * pane roster and its events, adds a second passkey, signs out from the shell, signs in again
 * with the same discoverable passkey, revokes, and checks the gate after each step.
 *
 * `coordination` needs the owner gate too, with a disposable in-memory queue that answers like OpenRig
 * (server/fixtures/motoko/coordination-history.json): one submit, a result after more than 400
 * transitions, then a reload, a sign-out and a later sign-in show the same result with no second POST.
 *
 * Screenshots go to --out, at 1280×800 and 390×844. Nothing reads a real account or herdr.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import { useTestHerdr } from "./test-herdr.ts";
import { chromePath } from "./chrome-path.ts";
import { createServer } from "../server/index.ts";
import { mapRigStatus } from "../server/motoko-reader.ts";
import { collectMotoko, fixtureProvider } from "../server/motoko.ts";
import { TRANSITIONS_BUDGET, createCoordination, type CoordinationQueue } from "../server/motoko-coordination.ts";
import { syntheticServerOptions, syntheticNetworkCalls } from "./motoko-env.ts";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const stage = arg("stage");
const out = arg("out");
if ((stage !== "render" && stage !== "owner" && stage !== "coordination") || !out) throw new Error("Usage: motoko-browser-qa.ts --stage=render|owner|coordination --out=<dir>");
if (!process.env["HOME"]?.startsWith(tmpdir()) && !process.env["HOME"]?.includes("motoko-proof-")) throw new Error("Run this through scripts/motoko-env.ts: HOME is not a temporary one");
mkdirSync(out, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const;
const results: { step: string; ok: true }[] = [];
const step = async (name: string, run: () => Promise<void>): Promise<void> => { await run(); results.push({ step: name, ok: true }); console.log(`ok - ${name}`); };

async function openMotoko(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^More/ }).click();
  await page.getByRole("menuitem", { name: "Motoko" }).click();
  await page.getByRole("heading", { name: "Motoko", level: 1 }).waitFor();
}

async function checkStatusView(page: Page): Promise<void> {
  if (await page.getByRole("region", { name: "Motoko boot status" }).count()) await page.getByRole("tab", { name: "Status", exact: true }).click();
  const view = page.locator(".motoko");
  await view.getByText("Fictional fixture data.", { exact: false }).waitFor();
  // the builder's two applied entries, its duplicate receipt and its requested one: 2
  const builder = view.locator(".motoko-card", { hasText: "builder@sample-build" });
  assert.match(await builder.innerText(), /Applied compactions\s*2\b/i);
  assert.match(await builder.innerText(), /42% · 84,000 of 200,000/);
  const reviewer = view.locator(".motoko-card", { hasText: "reviewer@sample-build" });
  assert.match(await reviewer.innerText(), /Unknown: context window not reported/);
  assert.match(await reviewer.innerText(), /Unknown: compaction receipts not reported/);
  assert.doesNotMatch(await reviewer.innerText(), /\b0%/);
  // the agent's markup is its text, not an element
  const summary = view.locator(".motoko-summary").first();
  assert.match(await summary.innerText(), /<b>approve<\/b>/);
  assert.equal(await summary.locator("b").count(), 0);
}

async function screens(page: Page, name: string): Promise<void> {
  for (const [label, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    // a drawer that changes its layout at this width slides: the picture waits for it to settle
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
    // no horizontal scroll at phone width
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${name} ${label}: no horizontal scroll (${overflow}px)`);
    await page.screenshot({ path: join(out!, `${name}-${label}.png`) });
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

async function render(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    Math.random = () => 0;
    const pending = new Set<number>();
    (window as unknown as { bootAgeTimers: Set<number> }).bootAgeTimers = pending;
    const schedule = window.setTimeout.bind(window), cancel = window.clearTimeout.bind(window);
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = schedule(callback, delay, ...args);
      if (delay !== undefined && delay > 980_000 && delay < 990_000) pending.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (id !== undefined) pending.delete(id); cancel(id); }) as typeof window.clearTimeout;
  });
  const poseRequests: string[] = [];
  page.on("request", (request) => { if (/\/(smile|wine|glance|shrug|visor)[-.]/.test(new URL(request.url()).pathname)) poseRequests.push(request.url()); });
  const ownerAuth = { required: false, authenticated: true, via: "owner", role: "drive", owner: { enrolled: true } };
  await page.route("**/api/health**", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, auth: ownerAuth } });
  });
  await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: await collectMotoko(fixtureProvider("normal"), Date.now) }));
  await page.route("**/api/owner/sessions", async (route) => route.fulfill({ json: {
    sessions: [{ id: "s1", credential_id: "c1", created_at: new Date().toISOString(), last_active_at: new Date().toISOString(), observed_ip: "127.0.0.1", user_agent: "Fixture browser", current: true }],
    credentials: [{ id: "c1", label: "Fixture laptop", status: "active", created_at: new Date().toISOString(), last_used_at: null }],
  } }));
  await page.goto(`${origin}/?page=motoko`);
  await step("render: a direct Motoko link opens the view", async () => { await page.getByRole("heading", { name: "Motoko", level: 1 }).waitFor(); });
  await step("render: boot entry and one selected pose", async () => {
    const boot = page.getByRole("region", { name: "Motoko boot status" });
    await boot.getByRole("heading", { name: "Motoko status" }).waitFor();
    await boot.getByText("sample-build, sample-ops", { exact: true }).waitFor();
    assert.equal(await boot.locator("img").count(), 1);
    assert.equal(poseRequests.length, 1, "only the selected pose is requested");
    await boot.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    assert.match(await boot.innerText(), /No terminal command starts here/);
  });
  await step("render: boot replay and keyboard route", async () => {
    const image = page.locator(".motoko-boot-portrait"); const first = await image.getAttribute("src");
    const replay = page.getByRole("button", { name: "Replay boot" });
    await replay.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction((previous) => document.querySelector(".motoko-boot-portrait")?.getAttribute("src") !== previous, first);
    assert.notEqual(await image.getAttribute("src"), first);
    const poses = new Set([first, await image.getAttribute("src")]);
    for (let i = 0; i < 3; i++) { await replay.click(); await image.evaluate((img: HTMLImageElement) => img.decode()); poses.add(await image.getAttribute("src")); }
    assert.equal(poses.size, 5, "all pinned colour poses decode in the browser");
    await screens(page, "boot");
    await page.getByRole("button", { name: "Open Motoko status" }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".motoko-boot").count(), 0);
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect)?.target instanceof Element && (a.effect as KeyframeEffect).target?.closest(".motoko-boot")).length), 0);
  });
  await step("render: status rules", () => checkStatusView(page));
  await step("render: status screenshots", () => screens(page, "render-status"));
  await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: { ...await collectMotoko(fixtureProvider("normal"), Date.now), sampledAt: new Date(Date.now() - 840_000).toISOString() } }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await step("render: stale banner", async () => { await page.getByText("This sample is stale", { exact: false }).waitFor(); });
  await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: { sampledAt: new Date().toISOString(), staleAfterMs: 0, source: "fixture", rigs: [], needsYou: [], errors: [{ source: "fixture", code: "collector_failed", message: "The status source failed." }] } }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await step("render: failed source shows no rigs", async () => {
    await page.getByText("The status source failed.").waitFor();
    assert.equal(await page.locator(".motoko .motoko-card").count(), 0);
  });
  await step("render: failure screenshots", () => screens(page, "render-error"));
  const roster = mapRigStatus({ rigId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", rigName: "fiction-lab", perSeat: [{ logicalId: "team.reader-test", runtime: "codex", lifecycleState: "running", intendedAction: "awaiting-decision", blocked: true }] }, 0, motokoTarget(ENV));
  const rosterProvider = Object.assign(async () => roster, { source: "OpenRig" as const });
  await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: await collectMotoko(rosterProvider, Date.now) }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await step("render: OpenRig coverage remains unknown", async () => {
    await page.getByText("OpenRig roster: the configured rig only.", { exact: false }).waitFor();
    await page.getByText("Owner requests are not reported by this source.", { exact: true }).waitFor();
    const metrics = page.locator(".motoko-metrics");
    assert.equal(await metrics.locator("div").filter({ hasText: "Needs input" }).locator("dd").innerText(), "Unknown");
    assert.equal(await metrics.locator("div").filter({ hasText: "Needs you" }).locator("dd").innerText(), "Unknown");
    assert.match(await page.locator(".motoko-card").innerText(), /Workflow: running · awaiting-decision/);
    assert.equal(await page.locator(".motoko-summary").count(), 0);
  });
  await step("render: boot unknown, stale and source errors", async () => {
    for (const name of ["unknown", "stale", "error", "malformed", "timeout"]) {
      const provider = name === "unknown" ? rosterProvider : fixtureProvider(name);
      await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: await collectMotoko(provider, Date.now, 20) }));
      await page.getByRole("tab", { name: "Boot", exact: true }).click();
      const boot = page.getByRole("region", { name: "Motoko boot status" });
      if (name === "unknown") {
        await boot.getByText("Agent activity and owner requests are not reported.", { exact: true }).waitFor();
        assert.match(await boot.innerText(), /Needs you:\s*Unknown/);
        assert.doesNotMatch(await boot.innerText(), /Nothing waits on you/);
      } else if (name === "stale") await boot.getByText("Stale sample", { exact: true }).waitFor();
      else { await boot.getByRole("alert").waitFor(); assert.match(await boot.innerText(), /Seats:\s*Unknown/); }
      await page.getByRole("tab", { name: "Status", exact: true }).click();
    }
  });
  await step("render: reduced motion has one still image and no boot animations", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: await collectMotoko(fixtureProvider("normal"), Date.now) }));
    await page.getByRole("tab", { name: "Boot", exact: true }).click();
    const boot = page.getByRole("region", { name: "Motoko boot status" });
    await boot.getByText("sample-build, sample-ops", { exact: true }).waitFor();
    await boot.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    assert.equal(await boot.getAttribute("data-reduced-motion"), "true");
    assert.match((await boot.locator("img").getAttribute("src"))!, /smile-still-/);
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect)?.target instanceof Element && (a.effect as KeyframeEffect).target?.closest(".motoko-boot")).length), 0);
    await page.setViewportSize(VIEWPORTS.phone);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    await page.screenshot({ path: join(out!, "boot-reduced-phone.png") });
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.getByRole("tab", { name: "Status", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });
  await step("render: unmount clears the sample timer and aborts a pending read", async () => {
    const fresh = { ...await collectMotoko(fixtureProvider("normal"), Date.now), sampledAt: new Date().toISOString(), staleAfterMs: 987_654 };
    await page.route("**/api/motoko/status", async (route) => route.fulfill({ json: fresh }));
    await page.getByRole("tab", { name: "Boot", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { bootAgeTimers: Set<number> }).bootAgeTimers.size === 1);
    await page.getByRole("tab", { name: "Access", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { bootAgeTimers: Set<number> }).bootAgeTimers.size), 0);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/motoko/status", async (route) => { entered(); await held; await route.fulfill({ json: fresh }).catch(() => {}); });
    await page.getByRole("tab", { name: "Boot", exact: true }).click();
    await pending;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("/api/motoko/status") });
    await page.getByRole("tab", { name: "Access", exact: true }).click();
    release();
    await aborted;
    assert.equal(await page.locator(".motoko-boot").count(), 0);
  });
  await page.getByRole("tab", { name: "Access" }).click();
  await step("render: access view labels", async () => {
    await page.getByRole("button", { name: "Revoke passkey Fixture laptop" }).waitFor();
    await page.getByRole("button", { name: "Revoke session from Fixture browser" }).waitFor();
  });
  await step("render: access screenshots", () => screens(page, "render-access"));
  assert.deepEqual(await page.evaluate(() => (window as unknown as { cspFailures: string[] }).cspFailures), [], "no CSP violation");
  await page.close();
}

/** An authenticator that keeps discoverable passkeys and verifies its user. */
async function authenticator(cdp: CDPSession, transport: "internal" | "usb" = "internal"): Promise<string> {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return authenticatorId;
}

async function owner(context: BrowserContext, origin: string, stateDir: string): Promise<void> {
  const page = await context.newPage();
  const errors: string[] = [];
  const privateRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/motoko/status") || /(?:smile|wine|glance|shrug|visor)[-.]/.test(request.url())) privateRequests.push(request.url()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const first = await authenticator(cdp);
  const cookieHeader = async () => (await context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

  await page.goto(origin + "/?page=motoko");
  await step("owner: the gate asks for the first passkey", async () => { await page.getByTestId("owner-gate").waitFor(); await page.getByLabel("Enrollment token").waitFor(); });
  await step("owner: signed-out Motoko data and images stay absent", async () => {
    assert.deepEqual(privateRequests, []);
    assert.equal(await page.locator(".motoko-boot").count(), 0);
    assert.equal((await page.request.get(origin + "/api/motoko/status")).status(), 401);
  });
  await step("owner: a wrong token is refused, announced, and focus returns", async () => {
    await page.getByLabel("Enrollment token").fill("wrong-token");
    await page.getByRole("button", { name: "Enroll passkey" }).click();
    await page.getByRole("alert").filter({ hasText: /enrollment token is wrong|Create a new one/ }).waitFor();
    assert.equal(await page.getByLabel("Enrollment token").inputValue(), "", "the token input is cleared at submit");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Enroll passkey");
  });
  await screens(page, "owner-gate-error");

  const token = "qa-" + crypto.randomUUID();
  writeFileSync(join(stateDir, "owner-enroll.token"), JSON.stringify({ token, expiresAt: Date.now() + 600_000, failures: 0 }), { mode: 0o600 });
  await step("owner: enroll, prove possession, and reach the local pane roster and its events", async () => {
    const events = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/machines/events" && response.status() === 200, { timeout: 20_000 });
    await page.getByLabel("Enrollment token").fill(token);
    await page.getByLabel("Name for this passkey").fill("QA laptop");
    await page.getByRole("button", { name: "Enroll passkey" }).click();
    await page.locator(".conn-live").waitFor({ timeout: 20_000 });
    await events;
    const machines = await (await fetch(`${origin}/api/machines`, { headers: { cookie: await cookieHeader() } })).json() as { machines: { kind: string }[] };
    assert.deepEqual(machines.machines.map((machine) => machine.kind), ["local"]);
  });

  await openMotoko(page);
  await step("owner: boot through the gate", async () => { await page.getByRole("region", { name: "Motoko boot status" }).waitFor(); await page.locator(".motoko-boot-portrait").evaluate((img: HTMLImageElement) => img.decode()); });
  await step("owner: status through the gate", () => checkStatusView(page));
  await screens(page, "owner-status");

  await page.getByRole("tab", { name: "Access" }).click();
  await step("owner: another passkey needs an existing one first", async () => {
    // the existing passkey signs the authorization; the new authenticator alone then registers and proves
    let saved: Awaited<ReturnType<typeof cdp.send<"WebAuthn.getCredentials">>>["credentials"] = [];
    let second = "";
    await page.route("**/api/owner/credentials/add/authorize", async (route) => {
      const response = await route.fetch();
      // copied after it signed the authorization: an older copy's counter is refused as a clone
      saved = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: first })).credentials;
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first });
      // a security key: Chrome keeps one built-in authenticator at a time
      second = await authenticator(cdp, "usb");
      await route.fulfill({ response });
    });
    await page.getByLabel("Name for another passkey").fill("QA backup");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await page.getByText("Passkey added.").waitFor({ timeout: 20_000 });
    await page.unroute("**/api/owner/credentials/add/authorize");
    // both keys back on one device, as an owner with a laptop and a security key would have
    const restored = await authenticator(cdp);
    for (const credential of saved) await cdp.send("WebAuthn.addCredential", { authenticatorId: restored, credential });
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: second });
    await page.getByRole("button", { name: "Revoke passkey QA backup" }).waitFor();
  });
  await screens(page, "owner-access");

  await step("owner: revoke the second passkey with the keyboard", async () => {
    await page.getByRole("button", { name: "Revoke passkey QA backup" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Revoke" }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Revoked.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Revoke passkey QA backup" }).count(), 0);
  });

  await step("owner: Phone & devices shows passkey guidance only (no phone sharing, no Portal, no requests for them); the sign-out row and confirmation name only the passkey; the shell's sign-out ends the session on the server and closes the event stream", async () => {
    const old = await cookieHeader();
    const stream = await fetch(`${origin}/api/machines/events`, { headers: { cookie: old } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })();
    await page.getByRole("button", { name: "Close Motoko" }).click();
    const legacyRequests: string[] = [];
    const recordLegacy = (request: { url(): string }) => { const path = new URL(request.url()).pathname; if (path === "/api/access" || path.startsWith("/api/portal")) legacyRequests.push(path); };
    page.on("request", recordLegacy);
    await page.goto(`${origin}/?settings=devices`);
    // the owner gate turns pairing and the token off: the sign-out text promises the passkey only
    await page.getByText("End this browser's owner session. Getting back in takes the owner's passkey.", { exact: true }).waitFor();
    // no legacy phone sharing guidance, no public tunnel controls, and no requests for either
    await page.getByText("On a phone, open this server's address and sign in with your owner passkey.", { exact: true }).waitFor();
    assert.equal(await page.locator(".phone-panel").count(), 0, "no legacy phone sharing guidance");
    assert.equal(await page.getByText("Your own Tailscale devices get in as you", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Portal", exact: true }).count(), 0, "no Portal group");
    assert.equal(await page.getByText("public HTTPS address", { exact: false }).count(), 0);
    page.off("request", recordLegacy);
    assert.deepEqual(legacyRequests, [], "no remote-access or Portal requests in owner mode");
    assert.equal(await page.getByText("Getting back in takes the access token or a pairing code", { exact: false }).count(), 0);
    await page.getByRole("button", { name: "Sign out" }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByText("The owner session ends on the server. Getting back in takes the owner's passkey: pairing codes and the access token are off while owner passkey sign-in is on.", { exact: true }).waitFor();
    assert.doesNotMatch(await confirm.innerText(), /takes the access token|pairing code from the PC|pair command/);
    await confirm.getByRole("button", { name: "Sign out" }).click();
    await page.getByTestId("owner-gate").waitFor();
    assert.equal(await Promise.race([ended, Bun.sleep(5_000).then(() => false)]), true, "the old event stream closed");
    assert.equal((await fetch(`${origin}/api/session`, { headers: { cookie: old } })).status, 401, "the old cookie is refused");
  });

  await step("owner: a closed prompt is a canceled sign-in, not an error, and focus returns", async () => {
    await page.route("**/api/owner/sign-in/options", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { ceremonyId: string; options: Record<string, unknown> };
      // no authenticator answers: the browser's own prompt ends as it does when closed
      await route.fulfill({ response, json: { ...body, options: { ...body.options, timeout: 1_000, rpId: "localhost", allowCredentials: [{ id: "AAAA", type: "public-key" }] } } });
    });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("status").filter({ hasText: "Passkey prompt canceled" }).waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Sign in with a passkey");
    await page.unroute("**/api/owner/sign-in/options");
  });

  await step("owner: a file tab shows the passkey gate too", async () => {
    const reader = await context.newPage();
    await reader.goto(`${origin}/?read=${encodeURIComponent("/tmp/none.md")}`);
    await reader.getByTestId("owner-gate").waitFor();
    await reader.close();
  });

  await step("owner: later sign-in with the same discoverable passkey, from the keyboard", async () => {
    await page.getByRole("button", { name: "Sign in with a passkey" }).focus();
    await page.keyboard.press("Enter");
    await page.locator(".conn-live").waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
      throw new Error(`no shell after sign-in; page says: ${await page.getByRole("alert").allInnerTexts()}`, { cause: error });
    });
  });

  await step("owner: revoking this session from Access returns the gate", async () => {
    // the sign-out step left Settings open: the direct link is the other way in
    await page.goto(`${origin}/?page=motoko`);
    await page.getByRole("heading", { name: "Motoko", level: 1 }).waitFor();
    await page.getByRole("tab", { name: "Access" }).click();
    const own = page.locator(".motoko-card", { hasText: "this browser" }).getByRole("button", { name: /^Revoke session/ });
    await own.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await page.getByTestId("owner-gate").waitFor();
  });
  await screens(page, "owner-signed-out");
  assert.deepEqual(errors, [], "the page raised no error");
  assert.deepEqual(await page.evaluate(() => (window as unknown as { cspFailures: string[] }).cspFailures), [], "no CSP violation");
  await page.close();
}

const HISTORY = JSON.parse(readFileSync(join(import.meta.dir, "../server/fixtures/motoko/coordination-history.json"), "utf8")) as { transitions: number; noteBytes: number; request: string; result: string };

/** A disposable queue with OpenRig's create semantics; `finish` adds the history and the orchestrator's result. */
function qaQueue() {
  const items = new Map<string, Record<string, unknown>>(), rows = new Map<string, Record<string, unknown>[]>();
  const reply = (status: number, value: unknown) => ({ status, bytes: new TextEncoder().encode(JSON.stringify(value)) });
  const queue: CoordinationQueue = {
    async create(input) {
      const item = items.get(input.qitemId) ?? { qitemId: input.qitemId, sourceSession: input.sourceSession, destinationSession: input.destinationSession, body: input.body, state: "pending", blockedOn: null, handedOffTo: null, closureReason: null, lastNudgeResult: "delivered-ack-pending", deliveryOutcome: null, tsUpdated: new Date().toISOString() };
      items.set(input.qitemId, item);
      if (!rows.has(input.qitemId)) rows.set(input.qitemId, [{ transitionId: 1, qitemId: input.qitemId, ts: new Date().toISOString(), state: "pending", transitionNote: null, actorSession: input.sourceSession, closureReason: null, closureTarget: null, identityProvenance: "claimed:v1" }]);
      return reply(201, item);
    },
    async item(id) { const item = items.get(id); return item ? reply(200, item) : reply(404, { error: "qitem_not_found" }); },
    async transitions(id) { return rows.has(id) ? reply(200, rows.get(id)) : reply(404, { error: "qitem_not_found" }); },
  };
  const finish = (requestId: string): number => {
    const qitemId = `qitem-motoko-${requestId}`, list = rows.get(qitemId)!;
    for (let i = 0; i < HISTORY.transitions; i++) list.push({ transitionId: list.length + 1, qitemId, ts: new Date().toISOString(), state: "in-progress", transitionNote: "x".repeat(HISTORY.noteBytes), actorSession: ORCHESTRATOR, closureReason: null, closureTarget: null, identityProvenance: "transport:v1" });
    list.push({ transitionId: list.length + 1, qitemId, ts: new Date().toISOString(), state: "done", transitionNote: JSON.stringify({ kind: "motoko-result-v1", requestId, qitemId, text: HISTORY.result }), actorSession: ORCHESTRATOR, closureReason: "no-follow-on", closureTarget: null, identityProvenance: "transport:v1" });
    items.get(qitemId)!["state"] = "done";
    return new TextEncoder().encode(JSON.stringify(list)).byteLength;
  };
  return { queue, finish };
}

async function coordination(context: BrowserContext, origin: string, stateDir: string, finish: (requestId: string) => number): Promise<void> {
  const page = await context.newPage();
  const posts: string[] = [];
  context.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/motoko/requests") posts.push(request.postData() ?? ""); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await authenticator(cdp);
  const token = "qa-" + crypto.randomUUID();
  writeFileSync(join(stateDir, "owner-enroll.token"), JSON.stringify({ token, expiresAt: Date.now() + 600_000, failures: 0 }), { mode: 0o600 });
  await page.goto(origin + "/?page=motoko");
  await step("coordination: enroll the owner", async () => {
    await page.getByLabel("Enrollment token").fill(token);
    await page.getByLabel("Name for this passkey").fill("QA laptop");
    await page.getByRole("button", { name: "Enroll passkey" }).click();
    await page.getByRole("heading", { name: "Motoko", level: 1 }).waitFor({ timeout: 20_000 });
  });
  const view = page.locator(".motoko");
  let requestId = "";
  await step("coordination: one submit saves the receipt and shows the queue state", async () => {
    await page.getByRole("tab", { name: "Requests" }).click();
    await page.getByLabel("Request to the orchestrator").fill(HISTORY.request);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await view.getByText("Saved locally. The queue state below", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Request to the orchestrator").inputValue(), "", "the text clears after the receipt is saved");
    assert.equal(posts.length, 1);
    const sent = JSON.parse(posts[0]!) as Record<string, string>;
    assert.deepEqual(Object.keys(sent).sort(), ["requestId", "text"]);
    assert.equal(sent["text"], HISTORY.request);
    requestId = sent["requestId"]!;
    const card = view.locator(".motoko-card", { hasText: requestId });
    assert.match(await card.innerText(), /Queue\s*pending/i);
    assert.match(await card.innerText(), /delivered-ack-pending/);
    assert.equal(await card.locator(".motoko-summary b").count(), 0, "the request text is text, not markup");
  });
  await screens(page, "coordination-pending");
  let bytes = 0;
  await step("coordination: the orchestrator's result after more than 400 transitions above 256 KiB", async () => {
    bytes = finish(requestId);
    assert.ok(bytes > 262_144 && bytes < TRANSITIONS_BUDGET, `history bytes ${bytes}`);
    await page.getByRole("button", { name: "Refresh" }).click();
    const card = view.locator(".motoko-card", { hasText: requestId });
    await card.getByText("Fictional plan:", { exact: false }).waitFor();
    assert.match(await card.innerText(), /Queue\s*done/i);
    assert.equal(await card.locator("i").count(), 0, "the result is text, not markup");
  });
  await screens(page, "coordination-result");
  const resultShown = async () => {
    await page.getByRole("heading", { name: "Motoko", level: 1 }).waitFor({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Requests" }).click();
    await view.locator(".motoko-card", { hasText: requestId }).getByText("Fictional plan:", { exact: false }).waitFor();
  };
  await step("coordination: a reload recovers the result without another POST", async () => {
    await page.goto(origin + "/?page=motoko");
    await resultShown();
    assert.equal(posts.length, 1);
  });
  await step("coordination: a later sign-in recovers the same result without another POST", async () => {
    const cookie = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    assert.equal((await fetch(origin + "/api/owner/sign-out", { method: "POST", headers: { cookie, origin, "x-herdr-machine": "1", "content-type": "application/json" }, body: "{}" })).status, 204);
    await page.goto(origin + "/?page=motoko");
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await resultShown();
    assert.equal(posts.length, 1);
  });
  results.push({ step: `coordination: history bytes ${bytes}`, ok: true });
  const stored = await page.evaluate(() => [localStorage, sessionStorage].flatMap((store) => Object.keys(store).map((key) => key + "=" + store.getItem(key))).join("\n"));
  for (const secret of [requestId, "Kyoto", "Fictional plan"]) assert.ok(!stored.includes(secret), `browser storage holds ${secret}`);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { cspFailures: string[] }).cspFailures), [], "no CSP violation");
  await page.close();
}

const root = mkdtempSync(join(tmpdir(), "motoko-qa-"));
await useTestHerdr();
const options = syntheticServerOptions(root);
const qa = qaQueue();
const server = stage === "coordination"
  ? createServer({ ...options, motokoProvider: fixtureProvider("normal"), owner: { rpId: "localhost", origin: "http://localhost:0" }, coordination: createCoordination({ stateDir: (options as { stateDir: string }).stateDir, binding: { rigId: RIG_ID, sourceSession: SOURCE, destinationSession: ORCHESTRATOR }, queue: qa.queue, now: Date.now }) } as Parameters<typeof createServer>[0])
  : stage === "owner"
  // the owner gate resolves its expected origin from this port once it is assigned (INTERFACE-CONTRACT-CORRECTIONS.md)
  ? createServer({ ...options, motokoProvider: fixtureProvider("normal"), owner: { rpId: "localhost", origin: "http://localhost:0" } } as Parameters<typeof createServer>[0])
  // the local roster, as owner mode keeps it: the runner's options turn PCs off for unit tests
  : createServer({ ...options, motokoProvider: fixtureProvider("normal"), machines: true });
const origin = `http://localhost:${server.port}`;
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, locale: "en-US" });
  const externalRequests: string[] = [];
  context.on("request", (request) => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
  await context.addInitScript(() => {
    (window as unknown as { cspFailures: string[] }).cspFailures = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { cspFailures: string[] }).cspFailures.push(event.violatedDirective));
  });
  await context.addInitScript(() => { try { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); } catch { /* storage off */ } });
  if (stage === "render") await render(context, origin);
  else if (stage === "coordination") await coordination(context, origin, (options as { stateDir: string }).stateDir, qa.finish);
  else await owner(context, origin, (options as { stateDir: string }).stateDir);
  assert.deepEqual(externalRequests, [], "no request leaves the app origin");
  assert.equal(syntheticNetworkCalls, 0, "no synthetic service reached the network");
  writeFileSync(join(out, `${stage}-results.json`), JSON.stringify({ stage, origin, results, syntheticNetworkCalls }, null, 2));
  console.log(`${stage}: ${results.length} steps passed`);
} finally {
  await browser.close();
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
