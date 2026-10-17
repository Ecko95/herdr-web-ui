# Motoko: design handoff

Motoko is a section of herdr web ui where the owner's Hermes agent orchestrates
[OpenRig](https://openrig.dev/what-is) rigs across their VPS hosts. herdr already holds every
OpenRig seat (each seat is a tmux session that `rig terminal open` tiles in herdr), so Motoko adds
the OpenRig layer on top of panes this app already shows. It does not draw its own terminals.

This folder is the design, not code. Build the feature in the real client (`src/`) and server
(`server/`), and make the browser demo (`site/demo/`) show it from fixtures.

## The files

`artboards/` holds the design canvas as it was exported. Each `*.dc.html` is one screen. They load
a canvas runtime (`support.js`) that is not in this repo, so they do not open in a browser. Read
them as a spec: the markup gives layout, copy and colors, and the `<script data-dc-script>` block
at the bottom of each holds the sample data and the interactions. `canvas.json` lists the screens
and their sizes.

| Artboard | Screen | Notes |
| --- | --- | --- |
| `Main.dc.html` | Motoko overview, desktop | Hosts, rigs, attention, operations workflow, activity |
| `Ask.dc.html` | Ask Motoko | Motoko's blinking mark, chat, Chat/Terminal switch, dictation, hands-free voice |
| `Rig.dc.html` | Rig explorer | Modelled on `rig tui`: hosts › rigs › pods › seats, table/health/topology tabs, a seat's pane |
| `Workflow.dc.html` | One operation | A Hermes queue item from decision to proof to done |
| `Mobile.dc.html` | Overview on a phone | 390 px |

**Motoko's mark** is in `logo/`: an animated dot-matrix portrait (in the style of a terminal
dot-matrix image) that blinks every few seconds, with an occasional double blink.

| File | Use |
| --- | --- |
| `logo/motoko-mono-full.webp` | Default boot-screen portrait on Ask Motoko: warm white dots, pink irises, transparent background, 200×200 dots, 1000 px |
| `logo/motoko-color-full.webp` | Colour variant (the artboard's `logoStyle` tweak), transparent, 200×200 dots, 1000 px |
| `logo/motoko-face-color.webp` | Face close-up for small places: chat avatar, header status |
| `logo/motoko-source.webp` | The source portrait |
| `logo/blink.py`, `logo/dots.py` | Regenerate them (Python 3 with Pillow and NumPy): `blink.py` paints the half-closed and closed eye frames, `dots.py` turns each frame into the dot grid and writes the animation |

```sh
python3 blink.py motoko-source.webp .                 # open.png, half.png, closed.png
ALPHA=1 python3 dots.py . 200 5 mono motoko-mono-full     # 200×200 dots, 5 px each, transparent
ALPHA=1 python3 dots.py . 200 5 color motoko-color-full
python3 dots.py . 28 4 color motoko-face-color 300,330,860,890   # face crop
```

The eye positions in `blink.py` are fitted to this portrait; a new source image needs new ones.
In the real client, respect `prefers-reduced-motion` by showing a still frame (the scripts also
write `*-open.png`).

`hermes-logo-white.svg` (dark theme) and `hermes-logo-black.svg` (light theme) are the Hermes Agent
logo supplied by the owner; Motoko's mark replaced it in the artboards.

## Screens

**Overview (`Main`)**
- A Motoko tab next to Panes and Agents in the top bar. Status pills: bridge, rig daemon, Hermes.
- Summary tiles: hosts healthy, seats working, needs input, waiting for you, Claude 5-hour usage
  (from `rig provider status`).
- VPS hosts: CPU, memory, disk, load sparkline, uptime; `rig doctor`, `rig health` and tmux seat
  count; service chips. Bars turn yellow at 75% and red at 85%.
- OpenRig rigs: one card per rig with spec, host, purpose, queue counts and every seat by address
  (`dev-builder@factory`), runtime and live activity. Activity is exactly OpenRig's four words:
  working, idle, needs-input, unknown. Unknown is a dashed dot, never shown as idle.
- Waiting for you: decision requests (OpenRig's attention view plus Hermes's own).
  Parked seats: from `rig parked`.
- Operations workflow: Detect › Plan › Decide › Claim › Proof › Close, with the current item.

**Ask Motoko (`Ask`)**
- **Boot screen first.** The page opens on a full-height screen styled like an old terminal (the
  design uses a fixed 848 px; the real page uses the viewport, `100dvh` minus the top bar):
  - a prompt line (`motoko@vps-01:~$ hermes --profile motoko`);
  - Motoko's portrait, frameless and as tall as the screen allows, revealed top to bottom in 28
    steps over 1.6 s, then blinking;
  - beside it, behind a vertical rule, boot lines printed one by one (about 0.11 s apart): version,
    profile, host and rig daemon, rigs, seat activity, host warnings, decisions waiting, date,
    recent conversations and the slash commands; then a blinking block cursor;
  - a notice between two accent rules for the most urgent decision;
  - "Scroll down to ask Motoko" with a bobbing chevron, linking to the chat below;
  - faint scanlines that flicker once and settle; a Replay boot button.
  With reduced motion everything is shown at once (no reveal, typing, cursor blink or flicker)
  and the portrait is a still frame. In voice mode the portrait glows in the accent colour.
- **Then the conversation.** Scrolling down reaches the conversations list and the chat; the
  message box stays pinned to the bottom of the screen while the conversation scrolls.
- Chat / Terminal switch, like herdr's own pane views. Terminal is the herdr pane where Hermes
  runs, with the existing key bar and terminal input line.
- Chat replies show the checks Hermes ran, then the answer, then optional cards (decisions with
  Review, a host card). Read aloud and Copy on each reply.
- The message box is herdr's composer: quick asks, attach, rig scope, context ring, Send.
  The mic is herdr's dictation: a recording pill with Cancel and Insert.
- Voice (hands-free): rings around the logo, a listening panel with the live transcript, Mute,
  End voice, and spoken replies.

**Rig explorer (`Rig`)**
- A read-only command bar showing the equivalent `rig tui` command.
- Explorer: hosts, then rigs › pods › seats. Selecting a seat shows its herdr pane with Send
  (`rig send`), Capture screen (`rig capture`) and Open tiles in herdr (`rig terminal open`).
- Tabs: table (seat, runtime, activity, queue item, state), health, topology (`delegates_to`
  edges, with Hermes handing work to `operator@kernel`).

**Operation (`Workflow`)**
- Queue item states are OpenRig's: pending, in-progress, blocked, done (with a closure reason).
- Decide: a checkbox ("I have read the steps and the target host") unlocks Approve. Approving
  resolves the item (blocked › in-progress) and wakes the owner seat. Deny closes it as denied.
  Ask to revise sends it back to Hermes and it stays blocked.
- Proof: the owner attaches it (`rig proof add`); only the reviewer seat in the proof policy can
  accept it. Closing the item alone does not count.

## Build notes

- **Reuse, do not rebuild.** Composer → `src/components/Composer.tsx`; dictation →
  `VoiceInput.tsx`; terminal → `PaneTerminal.tsx` and `KeyBar.tsx` / `TerminalInput.tsx`; chat →
  `ChatView.tsx` and `ChatTimeline.tsx`; command bar → `CommandPalette.tsx`.
- **Map colors back to tokens.** The artboards hardcode hex values copied from the dark amber
  palette in `src/styles.css`. Use the variables instead (`--bg`, `--bg-panel`, `--bg-elevated`,
  `--border`, `--text`, `--text-dim`, `--text-strong`, `--accent`, `--status-working`,
  `--status-blocked`, `--status-done`, `--status-idle`) so every palette and the light theme work.
  The fonts in the artboards (IBM Plex Sans, JetBrains Mono) stand in for `--font-ui` and
  `--font-mono`.
- **Server.** The server gets OpenRig data from the `rig` CLI and host metrics from the hosts. It
  talks to Hermes for chat and plans. Wrap them in new endpoints whose types live in `shared/`.
- **Demo.** Add fixtures to `site/demo/fixtures/` and answer the new endpoints in
  `site/demo/transport.ts`, using the artboards' sample data (rigs `kernel`, `factory`, `ops`;
  hosts `vps-01`, `vps-02`; items `ops-disk-0142`, `ops-release-007`). Every name and number in
  the design is fictional.

## Rules that apply here (from AGENTS.md)

- Hermes proposes; anything that changes a host or a rig waits for an explicit decision on screen,
  including requests made by voice.
- Dictation is only inserted into the box; nothing is sent on its own.
- Watching a seat never moves herdr's focus. Never pass `--takeover` to `herdr terminal attach`.
- Hermes never answers a seat's permission prompt. Prompt answers go through
  `POST /api/pane/prompt/answer`, never guessed digit keys.
- Tests and screenshots use the demo or a test session, never the owner's live rigs or hosts.
- A user-visible change adds a fragment to `changelog.d/`.

## Open questions

1. Where does Hermes sit: above OpenRig's kernel, handing work to `operator@kernel` (as designed),
   or as the orchestrator seat itself?
2. The exact `rig` flags for creating, resolving and listing queue items, and the `rig ps` output
   format. The OpenRig docs do not list them; check `rig --help` and the CLI reference.
3. Which speech service powers hands-free voice and spoken replies? Dictation already uses the
   OpenAI key in Settings › Voice input.
4. How Hermes is started in its pane: the design assumes `hermes --profile motoko`.
