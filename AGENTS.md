# cassie-bot

A TypeScript chatbot for the [Apron Chat Protocol](specs/apron-protocol-v10.md)
(v10, see `specs/` for the full spec). Built with Bun.

## Goal

An extensible bot runtime, modeled on Pi's extension system
(https://docs.pi.dev/latest/extensions). A user's intended workflow:

1. Make an empty directory for their personal bot.
2. `npm`/`bun install cassie-bot` (this repo) into it.
3. Write a TOML config file (bot name, Apron server address, rooms to join,
   enabled/disabled handlers).
4. Create a `handlers/` directory containing one TypeScript file per
   extension. Each file's default export is a function that receives the
   `bot` instance and registers itself via `bot.registerCommand` /
   `bot.registerListener` / `bot.registerResponder` (its own choice, akin
   to how a Pi extension registers itself). Named `handlers/`, not
   `commands/` or `extensions/` -- deliberately generic, matches the
   `Handler` type name, and leaves room for future extension kinds that
   do more than just message-handling.
5. Run the bot via a CLI pointed at the config file.

Supported extension kinds (decided, not yet all implemented):

- **Commands**: `/foo` one-off interactions (e.g. `/metar KLWC`,
  `/giphy <term>`). Note: Apron's own `command` capability (§4.1 of the
  spec) is server-side only (e.g. `/kick`) -- a bot client never receives
  a protocol-level `command` frame from another user. A human's `/metar`
  arrives as an ordinary `message` frame whose `body.text` happens to
  start with `/`. So "/commands" here are pure string-matching on normal
  messages, same mechanism as responders, no protocol capability needed.
- **Listeners**: pure side effects, e.g. logging every message. Never
  "claim" a message; always all run, return value ignored.
- **Responders**: keyword/pattern-based auto-replies (e.g. "needing help"
  -> doc link).

The `Bot` class itself does **no** detection/parsing of commands or
keywords. It just receives a message off the websocket and iterates
registries, letting each registered handler decide whether it applies.

## Decided architecture

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
- **Handler return semantics**, now reflected as two distinct types in
  `src/types.ts` (chosen over one shared type with a caveat, so the
  compiler -- not a comment -- enforces that a listener's return value
  can't be relied upon):
  - `ListenerHandler = (ctx) => Promise<void> | void` -- side-effect only,
    return value ignored, never stops dispatch.
  - `CommandHandler = (ctx) => Promise<boolean> | boolean` and
    `ResponderHandler = (ctx) => Promise<boolean> | boolean` -- `true`
    means "I handled this, stop dispatching further handlers in this
    registry."
  - `IMessageContext` (in `src/interfaces.ts`) is the shared context type
    all three handler kinds receive; not yet fleshed out (currently an
    empty interface).
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
  - **In-progress inconsistency to resolve, not a bug to silently fix**:
    `src/bot.ts` currently references `Registry<Handler>` (generic, with a
    single `Handler` type) and an `ApronMessage` type, but
    `src/registry.ts` is still a non-generic `Registry` (hardcoded to
    `CallableFunction`) and `src/types.ts` exports `ListenerHandler` /
    `CommandHandler` / `ResponderHandler` instead of one `Handler`. These
    files are mid-edit by the project owner; `src/bot.ts` does not
    currently compile against the other two. Don't "fix" this without
    checking first -- it's active work, not drift to clean up
    unilaterally.
- **`Config`** (`src/config.ts`) is now implemented, see below.

## `src/config.ts`

Fields, all with sensible defaults so a bare `new Config(path)` is usable
without loading a file:

- `configPath: string` -- set by the constructor, no default.
- `botName: string = "cassie-bot"` -- the display name the bot *requests*
  of the server via `auth.name` (Apron §3.2); the server may assign
  something else entirely.
- `serverUri: string = ""` -- the full server address as one URI (e.g.
  `wss://chat.example/ws`), not split into host/port. Per Apron §1,
  clients should identify a server by its whole, normalized address;
  splitting would lose the scheme (`ws` vs `wss` -- §5.1 flags unencrypted
  `ws://` as a real downgrade risk) and the path.
- `agent: string = "cassie-bot/0.1"` -- implementation string for the
  `agent` field on the `server` frame / `auth` request (§3.1/§3.2), purely
  for debugging on the server operator's end.
- `auth: { scheme: string; token?: string } = { scheme: "guest" }` --
  picks one of the server's advertised auth schemes (§3.2). Realistically
  `"guest"` or `"token"` for a bot; `webauthn`/`email`/`external` are all
  built around a human clicking through a browser flow. `auth.token` is
  only the *bootstrap* credential for `"token"` -- **TODO**: per §3.2.1 the
  server may rotate the token on each reply, and the client is expected
  to save the latest one for future connections, so a separate
  (gitignored) token-cache file will eventually be needed; the bootstrap
  value in the TOML goes stale after the first rotation.
- `rooms: string[] = []` -- **TODO**: only meaningful if the server
  advertises capability `"rooms"` (§3.4/§4.2); without it there's exactly
  one default room and no `room_join`. Need to check
  `server.capabilities` at connect time and warn/no-op gracefully.
  - **Fixed naming note**: originally considered `host`/`port`, replaced
    by `serverUri` above.
- `handlers: string[] = []` -- built-in + installed handler files to
  enable, by name.
- `disabled: string[] = []` -- built-in handler names to turn off with no
  replacement. (A handler file that re-registers a built-in's name, e.g.
  a custom `help` command, overrides it directly via the `Registry` and
  doesn't need to appear in this list -- that's a different mechanism.)
- **TODO**: reconnect/liveness policy. Honor `server.ping`'s interval
  (§1), don't auto-reconnect after a `denied` error, wait out
  `retry_after` before reconnecting (§1.1). No fields for this yet.

`Config.loadFromFile(configPath): Promise<Config>` is a **static factory
method**, not an instance method -- reading a file is inherently async and
a constructor can't be async, so it can't live on `new Config(...)`
itself. Call it as `const config = await Config.loadFromFile("./bot.toml")`.
It reads the file via `node:fs/promises` `readFile` (not `Bun.file` --
works identically under Node or Bun, since Bun implements Node's `fs`
itself; this package will be `npm install`ed by consumers who may not be
on Bun), parses TOML via the `smol-toml` dependency, and assigns each
field onto a fresh `Config` only if it's present and the right shape (two
small type guards, `isStringArray`/`isAuthTable`). A field with the wrong
type in the TOML is silently skipped, leaving the class default in place,
rather than throwing -- this was a deliberate but debatable permissive
choice (flagged to the project owner, not revisited yet); only a
missing/unreadable file causes `loadFromFile` to reject.

## Tests

`tests/` is a **top-level directory**, deliberately not alongside the
implementation files (project owner's preference). `tests/config.test.ts`
covers `Config` using Bun's built-in test runner (`bun:test`), with TOML
fixtures under `tests/fixtures/` (`full.toml`, `minimal.toml`,
`invalid-types.toml`). Run via `bun test` or `npm run test` (script now in
`package.json`). Currently 6 passing tests: constructor defaults, that
`loadFromFile` returns a genuinely new instance, a fully-populated file
round-trips every field, an omitted field falls back to its default, a
wrong-typed field is ignored rather than crashing, and a missing file
rejects.

## Dependencies

- `smol-toml` (runtime dep) -- TOML 1.0 parser, zero deps of its own,
  ships its own types. Chosen over Bun-specific or ad-hoc parsing since
  neither Node nor Bun parses TOML natively.
- `@types/bun` (dev), `typescript@^7` (peer) -- unchanged from initial
  scaffold.
- No WebSocket client chosen/added yet.

## In progress / next steps

- `src/bot.ts`, `src/registry.ts`, and `src/types.ts` are mid-edit by the
  project owner (see "in-progress inconsistency" note above) -- making
  `Registry` generic, consolidating or keeping split handler types, and
  wiring `Bot`'s three `register*` methods to the right registries with
  correctly-typed handlers (not untyped `CallableFunction`, which is
  still what `register*`/`Registry` use today).
- `IMessageContext` (`src/interfaces.ts`) is still an empty interface --
  needs real shape (presumably derived from an Apron `Message`, §3.5 of
  the spec, plus whatever a handler needs to send a reply).
- `ApronMessage` type referenced in `src/bot.ts` does not exist yet.
- Not yet designed/built: the `handlers/` dir loader/extension-loading
  convention, the actual websocket/Apron client (connect, `server`/`auth`
  handshake, room join, message send/receive), and the CLI entrypoint
  (`src/index.ts` is currently empty).

## Working style for this project (from the human partner)

- Step-by-step, not racing ahead -- implement what's asked, don't
  pre-build the rest. Don't "fix" in-progress files the human is actively
  editing without checking first.
- This is a learning project for them: their TypeScript is rusty and
  they don't know server-side WebSocket handling yet, so explanations
  alongside implementation are wanted, not just code dumped in.
- They want a real hand in writing it, not just reviewing fully-generated
  code.
- Watch for over-engineering ("architecture astronaut" tendency was
  self-flagged) -- prefer the simplest structure that fits the known
  extension kinds over speculative generality (e.g. a generic registry
  with an `options` bag for pattern/command-name customization was
  considered and explicitly dropped as unneeded complexity).
- Tests belong in a top-level `tests/` directory, not alongside
  implementation files.
