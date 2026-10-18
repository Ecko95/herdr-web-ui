import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript-api";
import { isNavigation, linkSearch, NAV_KEY, readLink, resolveLink } from "./deepLink.ts";

// Execute the actual App callbacks with local state setters, without importing terminals or a backend.
const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
function callback(name: string, scope: Record<string, unknown>, code = source): (...args: unknown[]) => void {
  const tree = ts.createSourceFile("callback.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (!expression && ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    if (name === "writeLink" && ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") {
      const effect = node.arguments[0];
      if (effect?.getText(tree).includes("writtenLink.current = link;")) expression = effect;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!expression) throw new Error(`App callback missing: ${name}`);
  const js = ts.transpileModule(`const extracted = (${expression.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(scope), `${js}; return extracted;`)(...Object.values(scope));
}
function shell() {
  const state = { page: "motoko" as string | null, drawer: true, selectedMachine: "local", selectedPane: "a" as string | null, automatic: true };
  const scope = {
    closeMotoko: () => { state.page = null; }, restoreMotoko: (page: string | null) => { state.page = page; },
    setDrawerOpen: (open: boolean) => { state.drawer = open; },
    setSelectedMachineId: (id: string) => { state.selectedMachine = id; },
    setSelectedPaneId: (id: string | null) => { state.selectedPane = id; },
    setAutoSelected: (automatic: boolean) => { state.automatic = automatic; },
    selectedMachineRef: { current: "local" }, setConnected() {}, setConnectedBefore() {}, setOutputStopped() {},
    setNotificationViewTarget() {}, storeSelection() {}, pendingLink: { current: null }, pendingFile: { current: null },
    setLinkLanded() {}, selectionHint: { current: null }, selectionSince: { current: 0 }, rosterSeq: { current: 1 },
  };
  return { state, scope };
}

it("PC and pane selection leave Motoko and close the drawer", () => {
  for (const [name, args] of [["selectTarget", ["local", "a"]], ["selectTarget", ["box", "b"]], ["selectPane", ["b"]]] as const) {
    const { state, scope } = shell();
    callback(name, scope)(...args);
    expect(state.page).toBeNull();
    expect(state.drawer).toBe(false);
    expect(state.automatic).toBe(false);
  }
});

it("the shared Motoko action closes the drawer without a pane selection or input", () => {
  // The action lives in the AppActions object rather than a named variable.
  const start = source.indexOf("openMotoko: openMotoko ?");
  expect(start).toBeGreaterThan(0);
  const body = source.slice(start, source.indexOf(" : null,", start));
  const expression = body.slice(body.indexOf("? ") + 2);
  const js = ts.transpileModule(`const extracted = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { state, scope } = shell();
  const opened: string[] = [];
  const action = new Function("setDrawerOpen", "setAutoSelected", "openMotoko", `${js}; return extracted;`)(scope.setDrawerOpen, scope.setAutoSelected, (destination: string) => opened.push(destination));
  action("sessions");
  expect(opened).toEqual(["sessions"]);
  expect(state).toMatchObject({ drawer: false, automatic: false, selectedMachine: "local", selectedPane: "a" });
});

it("popstate restores the page with no roster, no pane, the same pane, or another pane", () => {
  for (const roster of [[], [{ id: "local", snapshot: null }]]) {
    for (const pane of [null, "a", "b"]) {
      for (const page of [null, "motoko"] as const) {
        const { state, scope } = shell();
        const search = linkSearch({ machine: "local", workspace: null, pane, page, view: null, settings: null });
        const replacements: string[] = [];
        const pop = callback("onPop", {
          ...scope, settingsEntry: () => null, sheetSteppedOff: () => false, readLink, resolveLink, linkSearch,
          window: { location: { search, pathname: "/", hash: "" }, history: { state: {}, replaceState: (_state: unknown, _title: string, url: string) => replacements.push(url) } },
          machinesRef: { current: roster }, poppedTo: { current: false }, linkSince: { current: 0 },
          selectTargetRef: { current: callback("selectTarget", scope) },
          setNewSessionOpen() {}, pendingCreate: { current: null }, newSessionOpenRef: { current: false }, setHeaderNote() {},
          selectionRef: { current: { machineId: "local", paneId: "a" } },
          writtenLink: { current: { machine: "local", workspace: null, pane: "a", page: "motoko", view: null, settings: null } },
        });
        pop({ state: {} });
        expect({ roster: roster.length, pane, page, actual: state.page }).toEqual({ roster: roster.length, pane, page, actual: page });
        for (const url of replacements) expect(readLink(url.slice(1)).page).toBe(page);
      }
    }
  }
});


it("selection in the other split slot leaves Motoko", () => {
  for (const [active, other] of [["a", "b"], ["b", "a"]] as const) {
    const { state, scope } = shell();
    const selected: unknown[] = [];
    callback("selectInSlot", {
      ...scope, splitRef: { current: { active, bSide: "right" } }, splitOn: true,
      selectedMachineId: "local", selectedPaneId: "a",
      applySplit: (...args: unknown[]) => selected.push(args),
    })(other, "box", "b");
    expect(state.page).toBeNull();
    expect(selected).toEqual([[{ other: { machineId: "local", paneId: "a" }, bSide: "right", active: other }, { machineId: "box", paneId: "b" }, false]]);
  }
});

it("palette navigation suppresses focus return to a covered terminal", () => {
  const code = readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
  const navigated = { current: false };
  const calls: string[] = [];
  callback("runAction", { navigated, onClose: () => calls.push("close") }, code)({ navigates: true, run: () => calls.push("open") });
  expect(navigated.current).toBe(true);
  expect(calls).toEqual(["open", "close"]);
});


it("a page transition keeps its history entry after an automatic pane selection", () => {
  for (const motokoOpen of [true, false]) {
    const previous = { machine: "local", workspace: null, pane: "a", view: null, settings: null, page: motokoOpen ? null : "motoko" as const };
    const pushed: string[] = [];
    callback("writeLink", {
      locked: false, machines: [{}], snapshot: {}, linkWorkspaceId: null, linkLanded: true,
      selectedMachineId: "local", linkSlug: null, selectedPaneId: "a", view: null, linkFile: null,
      settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
      wideScreen: false, sidebarCollapsed: false, motokoOpen, newSessionOpen: false, newTab: null, newFields: null,
      writtenLink: { current: previous }, poppedTo: { current: false }, autoSelected: true, fileLeft: false,
      window: { location: { search: linkSearch(previous), pathname: "/", hash: "" }, history: { state: {}, pushState: (_state: unknown, _title: string, url: string) => pushed.push(url), replaceState() {} } },
      linkSearch, isNavigation, NAV_KEY,
    })();
    expect(pushed).toHaveLength(1);
    expect(readLink(pushed[0]!.slice(1)).page).toBe(motokoOpen ? "motoko" : null);
  }
});


it("same-page Back keeps the next explicit pane selection in history", () => {
  for (const page of [null, "motoko"] as const) {
    const { state, scope } = shell();
    state.page = page; state.automatic = false;
    const previous = { machine: "local", workspace: null, pane: "a", page, view: null, settings: null };
    const writtenLink = { current: previous }, poppedTo = { current: false };
    const writes: Array<{ method: string; url: string }> = [];
    const window = {
      location: { search: linkSearch(previous), pathname: "/", hash: "" },
      history: {
        state: {},
        pushState: (_state: unknown, _title: string, url: string) => writes.push({ method: "push", url }),
        replaceState: (_state: unknown, _title: string, url: string) => writes.push({ method: "replace", url }),
      },
    };
    callback("onPop", {
      ...scope, settingsEntry: () => null, sheetSteppedOff: () => false, readLink, resolveLink, linkSearch,
      window, writtenLink, poppedTo, machinesRef: { current: [{ id: "local", snapshot: null }] },
      linkSince: { current: 0 }, selectTargetRef: { current: callback("selectTarget", scope) },
      setNewSessionOpen() {}, pendingCreate: { current: null }, newSessionOpenRef: { current: false }, setHeaderNote() {},
      selectionRef: { current: { machineId: "local", paneId: "a" } },
    })({ state: {} });
    expect(state).toMatchObject({ page, automatic: false, selectedMachine: "local", selectedPane: "a" });
    callback("selectPane", scope)("b");
    callback("writeLink", {
      locked: false, machines: [{}], snapshot: {}, linkWorkspaceId: null, linkLanded: true,
      selectedMachineId: state.selectedMachine, linkSlug: null, selectedPaneId: state.selectedPane, view: null, linkFile: null,
      settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
      wideScreen: false, sidebarCollapsed: false, motokoOpen: state.page === "motoko", newSessionOpen: false, newTab: null, newFields: null,
      writtenLink, poppedTo, autoSelected: state.automatic, fileLeft: false, window, linkSearch, isNavigation, NAV_KEY,
    })();
    expect(writes.map(({ method }) => method)).toEqual(["push"]);
    expect(readLink(writes[0]!.url.slice(1))).toMatchObject({ machine: "local", pane: "b", page: null });
  }
});


it("Back and Forward restore a changed page or pane without a new history entry", () => {
  for (const [page, restored, pane] of [[null, "motoko", "a"], ["motoko", null, "a"], [null, null, "b"], ["motoko", "motoko", "b"]] as const) {
    const { state, scope } = shell();
    state.page = page; state.automatic = false;
    const previous = { machine: "local", workspace: null, pane: "a", page, view: null, settings: null };
    const writtenLink = { current: previous }, poppedTo = { current: false };
    const writes: Array<{ method: string; url: string }> = [];
    const window = {
      location: { search: linkSearch({ ...previous, page: restored, pane }), pathname: "/", hash: "" },
      history: {
        state: {},
        pushState: (_state: unknown, _title: string, url: string) => writes.push({ method: "push", url }),
        replaceState: (_state: unknown, _title: string, url: string) => writes.push({ method: "replace", url }),
      },
    };
    callback("onPop", {
      ...scope, settingsEntry: () => null, sheetSteppedOff: () => false, readLink, resolveLink, linkSearch,
      window, writtenLink, poppedTo, machinesRef: { current: [{ id: "local", snapshot: null }] },
      linkSince: { current: 0 }, selectTargetRef: { current: callback("selectTarget", scope) },
      setNewSessionOpen() {}, pendingCreate: { current: null }, newSessionOpenRef: { current: false }, setHeaderNote() {},
      selectionRef: { current: { machineId: "local", paneId: "a" } },
    })({ state: {} });
    callback("writeLink", {
      locked: false, machines: [{}], snapshot: {}, linkWorkspaceId: "workspace", linkLanded: true,
      selectedMachineId: state.selectedMachine, linkSlug: null, selectedPaneId: state.selectedPane, view: null, linkFile: null,
      settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
      wideScreen: false, sidebarCollapsed: false, motokoOpen: state.page === "motoko", newSessionOpen: false, newTab: null, newFields: null,
      writtenLink, poppedTo, autoSelected: state.automatic, fileLeft: false, window, linkSearch, isNavigation, NAV_KEY,
    })();
    expect(writes.map(({ method }) => method)).toEqual(["replace"]);
    expect(readLink(writes[0]!.url.slice(1))).toMatchObject({ workspace: "workspace", pane, page: restored });
    expect(poppedTo.current).toBe(false);
  }
});
