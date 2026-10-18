/** Private startup scope. Request fields never select this target. */
export interface MotokoTarget { rigId: string; rigName: string; sourceSession: string; humanId: string; destinationSession: string }

export function motokoTarget(env: Record<string, string | undefined>): MotokoTarget | null {
  const rigId = env["HERDR_WEB_MOTOKO_RIG_ID"];
  const rigName = env["HERDR_WEB_MOTOKO_RIG_NAME"];
  const sourceSession = env["HERDR_WEB_MOTOKO_SOURCE_SESSION"];
  if (!rigId || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(rigId) || !rigName || !/^[a-z][a-z0-9-]{0,47}$/.test(rigName) ||
    !sourceSession || !/^[a-z][a-z0-9-]{0,47}@external$/.test(sourceSession)) return null;
  return { rigId, rigName, sourceSession, humanId: sourceSession.slice(0, -"@external".length), destinationSession: `team-orchestrator@${rigName}` };
}
