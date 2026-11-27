# cassie-bot

A TypeScript chatbot for the [Apron Chat Protocol](specs/apron-protocol-v10.md)
(v10, see `specs/` for the full spec). Built with Bun.

## Goal

An extensible bot runtime, modeled on Pi's extension system
(https://docs.pi.dev/latest/extensions). A user's intended workflow:

1. Make an empty directory for their personal bot.
2. `npm`/`bun install cassie-bot` (this repo) into it.
3. Write a TOML config file (bot name, Apron server host, rooms to join,
   enabled extensions).
4. Create a `commands/` directory containing one TypeScript file per
   extension/command. Each file's default export is a function that
   receives the `bot` instance and registers itself via
   `bot.registerCommand` / `bot.registerListener` / `bot.registerResponder`
   (its own choice, akin to how a Pi extension registers itself).
5. Run the bot via a CLI pointed at the config file.

Supported extension kinds (decided, not yet all implemented):

- **Commands**: `/foo` one-off interactions (e.g. `/metar KLWC`,
  `/giphy <term>`). Note: Apron's own `command` capability (§4.1 of the
  spec) is server-side only (e.g. `/kick`) — a bot client never receives a
  protocol-level `command` frame from another user. A human's `/metar`
  arrives as an ordinary `message` frame whose `body.text` happens to
  start with `/`. So "/commands" here are pure string-matching on normal
  messages, same mechanism as responders, no protocol capability needed.
- **Listeners**: pure side effects, e.g. logging every message. Never
  "claim" a message; always all run.
- **Responders**: keyword/pattern-based auto-replies (e.g. "needing help"
  -> doc link).

The `Bot` class itself does **no** detection/parsing of commands or
keywords. It just receives a message off the websocket and iterates
registries, letting each registered handler decide whether it applies.

## Decided architecture (as of this session)

- **Three separate registries**, not one generic one: `commands`,
  `listeners`, `responders`. Rationale: each has a different dispatch
  contract (exact-name lookup + collision-is-an-error for commands vs.
  run-everything for listeners vs. first-match-wins for responders), and
  keeping them separate leaves room to evolve each independently later
  without having to tear apart one shared structure.
- **Dispatch order is a fixed pipeline, not merged registration order**:
  listeners (always, all, return value ignored) -> commands (registration
  order, stop at first handler returning `true`) -> responders
  (registration order, stop at first handler returning `true`).
- **`Registry`** (`src/registry.ts`) is keyed by a unique string `name`.
  `register(name, func)` throws if `name` is already taken.
  `unregister(name)` removes and returns the handler (or `undefined`).
  The `name` exists specifically so a user can override/disable a
  built-in by unregistering it and registering their own under the same
  name (e.g. swapping out a built-in `help` command).
  - `IRegistry` interface lives in `src/interfaces.ts`. Watch for
    interface/implementation drift: there was already one bug here
    (`unregister`'s return type didn't match between the two files) that
    got caught and fixed mid-session.
- **Handler return semantics** (decided, not yet encoded in types):
  - Commands & responders: handler returns `true`/`false`. `true` means
    "I handled this, stop dispatching further handlers in this registry."
  - Listeners: return value is ignored; they're side-effect only and
    never stop anything.
  - Leaning toward **two distinct handler types** rather than one shared
    type with a caveat, e.g. `Listener = (ctx) => Promise<void> | void`
    vs. `Matcher = (ctx) => Promise<boolean | void> | boolean | void`, so
    the compiler (not a comment) enforces that a listener's return value
    can't be relied upon. Not yet finalized/written.

## In progress / next steps

- A `src/types.ts` is about to be added with the `Handler` (or
  `Listener`/`Matcher` split) type(s) above, then `Registry`/`Bot`
  signatures get updated to use them instead of untyped
  `CallableFunction`.
- `src/config.ts` is a stub: fields declared (`botName`, `host`, `port`,
  `rooms`, `extensions`) but `loadFromFile` is unimplemented, and the
  constructor currently references `this.configPath` without it being a
  declared field (will not compile under `strict` — check this is fixed
  by the time it matters).
- Not yet designed/built: the TOML config loader, the `commands/` dir
  loader/extension-loading convention, the actual websocket/Apron client
  (connect, `server`/`auth` handshake, room join, message send/receive),
  and the CLI entrypoint (`src/index.ts` is currently empty).
- No dependencies installed yet beyond `@types/bun` (dev) and a
  `typescript@^7` peer dep. Will need a TOML parser and a WebSocket
  client (Bun has `WebSocket` built in) at minimum.

## Working style for this project (from the human partner)

- Step-by-step, not racing ahead — implement what's asked, don't
  pre-build the rest.
- This is a learning project for them: their TypeScript is rusty and
  they don't know server-side WebSocket handling yet, so explanations
  alongside implementation are wanted, not just code dumped in.
- They want a real hand in writing it, not just reviewing fully-generated
  code.
- Watch for over-engineering ("architecture astronaut" tendency was
  self-flagged) — prefer the simplest structure that fits the three
  known extension kinds over speculative generality (e.g. a generic
  registry with an `options` bag for pattern/command-name customization
  was considered and explicitly dropped as unneeded complexity).
