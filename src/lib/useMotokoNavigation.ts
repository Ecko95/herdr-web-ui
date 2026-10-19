import { useCallback, useState } from "react";
import type { MotokoDestination, MotokoRequest } from "./actions.ts";
import { ownerMode, type OwnerAuth } from "./motoko.ts";

/** Local page state only. The selected PC and its mounted terminals stay in App. */
export function useMotokoNavigation(auth: OwnerAuth | null, initial: boolean) {
  const [request, setRequest] = useState<MotokoRequest | null>(() => initial ? { destination: "boot" } : null);
  const open = useCallback((destination: MotokoDestination) => setRequest({ destination }), []);
  const close = useCallback(() => setRequest(null), []);
  const restore = useCallback((page: "motoko" | null | undefined) => setRequest(page === "motoko" ? { destination: "boot" } : null), []);
  return { request, open: ownerMode(auth) && auth?.authenticated ? open : null, close, restore };
}
