import { expect, test } from "bun:test";
import { OwnerError } from "./motoko-owner.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";

const revoked = () => { throw new OwnerError("owner_required", 401); };

test("pane mutation rechecks owner after the request body without an RPC", async () => {
  const url = new URL("http://localhost/api/pane/rename");
  const request = new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "fiction-pane", label: "Fiction" }) });
  const response = await handlePaneRequest(request, url, url.pathname, {}, revoked);
  expect(response?.status).toBe(401);
  expect(await response?.json()).toMatchObject({ error: { code: "owner_required" } });
});

test("workspace mutation rechecks owner after the request body without an RPC", async () => {
  const url = new URL("http://localhost/api/workspace/rename");
  const request = new Request(url, { method: "POST", body: JSON.stringify({ workspace_id: "fiction-workspace", label: "Fiction" }) });
  const response = await handleWorkspaceRequest(request, url, url.pathname, { timeout() {} }, () => {}, revoked);
  expect(response?.status).toBe(401);
  expect(await response?.json()).toMatchObject({ error: { code: "owner_required" } });
});
