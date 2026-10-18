### Added
- Motoko → Requests: the signed-in owner sends a request to the orchestrator's OpenRig queue and
  sees its history. The server saves a private receipt before it sends, fixes the source and
  destination itself, and shows OpenRig's own queue state, agent delivery and the orchestrator's
  final result. A reload or a later sign-in reads the history again and never resends. It is off
  unless `HERDR_WEB_MOTOKO_SOURCE_SESSION` names the registered owner address.
