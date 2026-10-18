# src/

- The auth token lives only in the HttpOnly cookie, never in localStorage or sessionStorage.
- A new setting needs its default and type check in `sanitizeSettings`, or it is silently dropped.
- Secret input stays in the DOM input only: never React state, a draft, a queue or a retry.
- Import only types from `shared/protocol.ts`: importing a value reads the server's environment.
- Before a new UI feature or a UI fix, look at how widely used coding-agent apps solve it (the
  Codex and Claude apps, Paseo, T3 Code; Zed, Warp or Conductor for terminal and multi-agent
  layouts), and name the one the design follows, or why it differs, in the PR and in the change's
  DESIGN.md entry when it has one. Their pixels are not copied; adapted code is credited in
  THIRD_PARTY_NOTICES.md.
