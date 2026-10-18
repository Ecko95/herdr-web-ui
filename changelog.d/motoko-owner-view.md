### Added
- Motoko, an owner's view of rigs and seats over the pane area (More → Motoko, or `?page=motoko`), on
  a server that runs owner passkey sign-in. It shows seat status and confidence, what needs you,
  context use against its window, sample age, stale and failed samples, and applied compactions
  counted once each; a value the source did not report shows as unknown, never as 0. Its data is
  fictional fixtures for now.
- Owner passkey sign-in in the browser: enroll the first passkey with a one-time token made over
  SSH, sign in, add another passkey, and see and revoke sessions and passkeys under Motoko →
  Access. Signing out ends the owner session on the server.
