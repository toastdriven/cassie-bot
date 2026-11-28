# cassie-bot

A TypeScript chatbot for the [Apron Chat Protocol](specs/apron-protocol-v10.md)
(v10, see `specs/` for the full spec). Built with Bun, but must also run
under plain Node >=22 once installed by a consumer (see "Running under
Node vs. Bun" below) -- that constraint shapes several decisions below.

Published as `@toastdriven/cassie-bot` (not yet actually published --
`package.json` has the metadata, but confirm with the project owner
before running `npm publish`). Version `0.2.0` (bumped from `0.1.0`;
a real release is pending as of this writing -- confirm with the project
owner before tagging/publishing). License: BSD-3-Clause (see `LICENSE`).
Repo: https://github.com/toastdriven/cassie-bot.

## Goal

An extensible bot runtime, modeled on Pi's extension system
(https://docs.pi.dev/latest/extensions). A user's intended workflow:

1. Make an empty directory for their personal bot.
2. `npm`/`bun install @toastdriven/cassie-bot` into it.
3. Write a `bot.toml` config file (bot name, Apron server address, rooms
   to join, enabled/disabled handlers, auth).
4. Create a `handlers/` directory next to `bot.toml`, containing one
   TypeScript file per extension. Each file's default export is a
   function that receives the `Bot` instance and registers itself via
   `bot.registerCommand` / `bot.registerListener` / `bot.registerResponder`
   (its own choice, akin to how a Pi extension registers itself). Named
   `handlers/`, not `commands/` or `extensions/` -- deliberately generic,
   matches the `*Handler` type names, and leaves room for future
   extension kinds that do more than just message-handling.
5. Run via the `cassie-bot` CLI, pointed at the config file:
   `cassie-bot --config bot.toml`.

This is **fully implemented** now, end to end (connect, authenticate, load
handlers, dispatch messages, graceful shutdown) -- not just designed. See
"Current state" below for what's actually built vs. still open.

Three extension kinds:

- **Commands**: `/foo` one-off interactions (e.g. `/help`, a hypothetical
  `/metar KLWC`). Note: Apron's own `command` capability (§4.1 of the
  spec) is server-side only (e.g. `/kick`) -- a bot client never receives
  a protocol-level `command` frame from another user. A human's `/help`
  arrives as an ordinary `message` frame whose `text` happens to start
  with `/`. So "/commands" here are pure string-matching on normal
  messages, same mechanism as responders, no protocol capability needed.
- **Listeners**: pure side effects, e.g. logging every message. Never
  "claim" a message; return value ignored; always all run regardless of
  what others did.
- **Responders**: keyword/pattern-based auto-replies (e.g. mentioning
  "ethereum" + "price" -> a price lookup and reply).

The `Bot` class itself does **no** detection/parsing of commands or
keywords. It just receives a message off the websocket and iterates
registries, letting each registered handler decide whether it applies.

A command handler claims by exact/prefix string match on `text`; a
responder claims by keyword/pattern on `text`, OR (new convention,
established by the built-in `help` responder -- see below) by checking
`ctx.message.mentions.includes(bot.you?.userId)` to react to an `@`
mention of the bot's *current* name specifically, since the server may
intercept a literal `/command`-shaped string in the web UI before it
ever reaches the bot as a normal message.

## Decided architecture

- **Three separate registries**: `Bot.listenerRegistry`,
  `Bot.commandRegistry`, `Bot.responderRegistry`, each a
  `Registry<SomeHandlerType>` (generic, see `src/registry.ts`). Rationale:
  each kind has a different dispatch contract, and keeping them separate
  leaves room to evolve each independently later.
- **Dispatch order is a fixed pipeline** (`Bot.onMessage`, `src/bot.ts`):
  listeners (always, all, return value ignored) -> commands (registration
  order, stop at first handler returning `true`) -> responders
  (registration order, stop at first handler returning `true`, only
  reached if no command claimed the message).
- **Handler types** (`src/types.ts`):
  - `ListenerHandler = (ctx: IMessageContext) => Promise<void> | void`
  - `CommandHandler = (ctx: IMessageContext) => Promise<boolean> | boolean`
  - `ResponderHandler = (ctx: IMessageContext) => Promise<boolean> | boolean`
- **Registration signature, same shape for all three** (note the
  argument order -- `options` comes *before* the function, not after;
  this was deliberately changed mid-project to read better and to
  encourage always filling in `options`):
  ```ts
  register(name: string, options: IHandlerOptions | undefined, func: T): void
  ```
  `Bot.registerListener` / `registerCommand` / `registerResponder` are
  thin wrappers with this same signature, one per registry.
- **`Registry<T>`** (`src/registry.ts`), generic, keyed by a unique string
  `name`:
  - `register(name, options, func)` -- **throws** if `name` is already
    taken within that registry. Does NOT silently replace. To swap out a
    built-in, a user needs both: the built-in's name in `Config.disabled`
    (so cassie-bot never registers it) AND their own handler registered
    under that same name.
  - `unregister(name)` -- removes and returns the handler, or `undefined`.
  - `describe(name)` -- returns the `IHandlerOptions` a handler was
    registered with (currently just `{ description?: string }`), or
    `undefined`.
  - `[Symbol.iterator]()` / `entries()` -- yields `[name, handler]` pairs
    in registration order (backed by `Map`, which preserves insertion
    order -- this is what gives commands/responders their ordering
    guarantee).
  - `list()` -- yields `[name, options]` pairs, for anything that wants
    to describe what's registered (e.g. `/help`) without needing the
    handler functions themselves.
  - `IRegistry<T>` interface lives in `src/interfaces.ts`.
- **`Bot.listHandlers(): IHandlerDescription[]`** (`src/bot.ts`) --
  consolidates all three registries' `list()` output, each entry tagged
  with `kind: "listener" | "command" | "responder"`. Lets something like
  `/help` describe everything registered without reaching into
  `bot.listenerRegistry`/etc. directly.
- **`IMessageContext`** (`src/interfaces.ts`) -- what every handler
  receives: `message: IChatMessage` (readonly) and
  `reply(text, options?: { format? }): Promise<void>` (sends a new
  message back to the room the incoming one arrived in).
- **`IChatMessage`** (`src/interfaces.ts`) -- the camelCase, internal-only
  shape of a chat message (`text`, `format`, `from: { userId, name? }`,
  `roomId?`, `mentions: string[]`). Mirrors Apron §3.5's `Message` but is
  NOT the wire format -- see "camelCase/snake_case boundary" below.
  Explicitly not yet modeled (documented as a TODO in the file itself):
  `message_id`/`log_id`/`prev_log_id`, `reply_to` (threading), `embeds`,
  roles on `from`. **Left alone deliberately** (project owner's explicit
  call, not an oversight) -- flesh out as the need actually arises, not
  speculatively.
- **`Bot.you: IUser | undefined`** (`src/bot.ts`) -- the bot's own
  identity, kept live across the whole connection, not just set once at
  auth time. The server is free to assign a *different* display name
  than the one requested in `config.botName` (confirmed live against a
  real server: requested `cassie-bot`, got back `Bot of toastdriven`),
  and per Apron §3.3.1 a `user` notification can update it again later
  (e.g. an operator renaming the bot mid-session). Two write sites, both
  going through the same `mergeUser()` helper so the "current object"
  merge rules (§3.3.1: omitted key keeps old value, empty string/array
  clears it, anything else replaces it) are applied consistently:
  - `authenticate()` sets `this.you = result.you` outright (the first,
    complete identity).
  - `receiveMessage()` merges a later `user` notification's `you` field
    into the existing `this.you`, field-by-field, rather than replacing
    the whole object (a notification may carry only the field that
    changed).
  This is what lets a responder check `ctx.message.mentions.includes(
  bot.you?.userId)` and have it track renames automatically instead of
  going stale after the first rename.

## camelCase / snake_case boundary

Apron frames on the wire are snake_case (`room_id`, `user_id`, ...);
everything internal to cassie-bot (handlers, `IChatMessage`,
`IMessageContext`) is camelCase. Conversion happens in exactly two places,
never anywhere else:

- `Bot.receiveMessage` -- converts an incoming frame snake_case -> camelCase
  before building an `IMessageContext`/dispatching.
- Just before `Bot` sends a frame (e.g. inside `authenticate`, `ping`,
  `sendMessage`, and `ctx.reply`) -- converts camelCase -> snake_case.

`src/utils.ts` provides the primitives, deliberately generic (no
special-casing for acronyms, arrays of primitives, Dates, etc. -- if a
field ever needs different treatment, handle it at the call site):
- `snakeToCamelKey` / `camelToSnakeKey` -- single-key string conversion.
- `snakeToCamel` / `camelToSnake` -- recursive, walks objects/arrays,
  leaves primitives alone.
- `isPlainObject` -- the `Array.isArray`-aware guard both of the above
  use internally.

All five are exported from `src/utils.ts` and tested directly in
`tests/utils.test.ts`.

## `src/config.ts`

Fields, all with sensible defaults so a bare `new Config(path)` is usable
without loading a file:

- `configPath: string` -- set by the constructor, no default. Used by
  `tokenCache.ts` to locate the token-cache file (same directory), and by
  `handlerLoader.ts` to locate the `handlers/` directory (same
  directory) -- **not** `process.cwd()`, so the bot behaves predictably
  regardless of where it's invoked from (e.g. a systemd service with an
  unrelated cwd).
- `botName: string = "cassie-bot"` -- the display name the bot *requests*
  of the server via `auth.name` (Apron §3.2); the server may assign
  something else entirely.
- `serverUri: string = ""` -- the full server address as one URI (e.g.
  `wss://chat.example/ws`), not split into host/port. Per Apron §1,
  clients should identify a server by its whole, normalized address.
- `agent: string = "cassie-bot/0.1"` -- implementation string for the
  `agent` field on the `auth` request (§3.2), purely for debugging on the
  server operator's end.
- `auth: { scheme: string; token?: string } = { scheme: "guest" }` --
  picks one of the server's advertised auth schemes (§3.2). `auth.token`
  is only the *bootstrap* credential for `scheme: "token"` -- see
  "Token persistence" below for what actually gets used at runtime.
- `rooms: string[] = []` -- rooms to join on startup, by display name
  (matched case-insensitively against a room's `title`, or failing that
  its raw `room_id` -- see `matchesRoomName()`/`Bot.postConnect()` in
  `src/bot.ts`). **Implemented.** Only meaningful if the server
  advertises capability `"rooms"` (§3.4/§4.2); `postConnect()` checks
  `server.capabilities` itself and warns + no-ops if this list is
  non-empty but the server lacks that capability. A configured name that
  doesn't resolve against the server's `room_list` throws
  `RoomNotFoundError` (`src/errors.ts`) -- deliberately fails loud rather
  than silently skipping, and the error carries every room the server
  *does* know about (`title`/`room_id` pairs) so the operator can see
  exactly what the server calls its rooms instead of guessing at exact
  text/casing/decoration (e.g. an emoji prefix a title carries that a
  plain-text TOML value doesn't).
- `handlers: string[] = []` -- **reserved, unimplemented**: intended for
  naming an npm-installed handler *package* in the future (as opposed to
  a file in the user's own `handlers/` directory, or a built-in). Not
  read/used by `loadHandlers` today.
- `disabled: string[] = []` -- names of cassie-bot's own built-ins
  (`help`, `ethereum-price`, `logging` -- see `handlerLoader.ts`) to skip
  registering. See the `Registry.register` note above for why this is
  required (not optional) when swapping out a built-in for a custom one
  of the same name.
- **Still a TODO, unimplemented**: reconnect/liveness policy -- honor
  `server.ping`'s interval properly beyond the existing ping timer (see
  `Bot.connect`), don't auto-reconnect after a `denied` error, wait out
  `retry_after` before reconnecting (§1.1). No actual reconnect logic
  exists; a dropped connection just... stays dropped. (This is the one
  item the project owner has flagged as wanting to dig into next, after
  the TS-packaging work below settles.)

`Config.loadFromFile(configPath): Promise<Config>` is a **static factory
method** (reading a file is async; a constructor can't be). Reads via
`node:fs/promises` `readFile` (not `Bun.file` -- must work identically
under plain Node, since consumers may not be on Bun), parses TOML via the
`smol-toml` dependency, and assigns each field onto a fresh `Config` only
if present and the right shape (`isStringArray`/`isAuthTable` type
guards). A wrong-typed field in the TOML is silently skipped (class
default stays), rather than throwing -- a deliberate but debatable
permissive choice; only a missing/unreadable file rejects.

## `src/bot.ts` -- the real websocket client (fully implemented)

- **`connect(): Promise<IServerInfo>`** -- opens a `WebSocket` to
  `config.serverUri`, resolves once the server's `server` greeting frame
  arrives (Apron §3.1: sent immediately on accept, before the client
  sends anything). Does NOT authenticate. Throws synchronously if called
  while already connected/connecting. Starts a ping timer if the greeting
  advertises `ping` (an interval in seconds).
- **`authenticate(): Promise<IAuthResult>`** -- sends `auth` using
  `config.auth`, with two safety checks layered on top of the bare
  request (see "Typed auth errors" below), and persists a rotated token
  (see "Token persistence" below). Sets `bot.you`/`bot.token` on success.
- **`ping(): void`** -- sends `{method: "ping"}` with no `id`, replying to
  the server's own liveness pings. Internal ping timer calls this on the
  advertised interval.
- **`sendMessage(text, options?): Promise<{ messageId: ... }>`** -- builds
  and sends a `message` request (camelCase in, snake_case on the wire),
  resolves with whatever the server assigns back.
- **`postConnect(): Promise<void>`** -- joins every room in
  `config.rooms` (see `rooms` field above for the matching/error
  behavior). Called by `cli.ts`'s `main()` after `authenticate()`
  succeeds.
- **`getRoomList(): Promise<IRoomListResult>`** -- `room_list` request
  (Apron §4.2.1, `filter: "all"`), returns the raw `joined`/`notJoined`/
  `left` arrays. `postConnect()` is the only caller today, but exposed
  publicly in case a handler wants to introspect rooms directly.
- **`joinRoom(roomId): Promise<void>`** -- `room_join` by server-assigned
  `room_id` (Apron §4.2.2; the reply is just `{}`, nothing to return).
  Takes a `room_id`, never a display name -- resolve one via
  `getRoomList()`/`postConnect()`'s matching logic first.
- **`disconnect(): void`** -- closes the socket if open; `_handleClose`
  (shared with an unexpected server-initiated close) stops the ping
  timer and rejects any requests still waiting on a reply.
- **`receiveMessage(data: string): void`** -- parses an incoming frame,
  converts snake_case -> camelCase, and either resolves a pending request
  (by `id`), or for a `message` notification builds an `IMessageContext`
  and calls `onMessage`. Logs (doesn't throw) on a reply whose `id`
  matches no pending request, or an unknown method -- see "onerror/
  unmatched ids" below.
- **`onMessage(ctx): Promise<void>`** -- the fixed listener -> command ->
  responder pipeline described above.
- **`_sendRequest<T>(method, params)`** -- internal helper: assigns a
  fresh request `id`, tracks a `PendingRequest` (`resolve`/`reject`) keyed
  by that `id`, sends the frame, and settles once `receiveMessage` finds
  the matching reply (`result` -> resolve, `error` -> reject with
  `ApronError`).

### Typed auth errors (`src/errors.ts`)

`authenticate()` upgrades two failure modes into typed errors instead of a
bare `ApronError`:

- **`UnsupportedSchemeError(scheme, offered)`** -- thrown *before* sending
  anything, if `config.auth.scheme` isn't in `serverInfo.auth` (Apron
  §3.2: "a scheme that the server does not offer is `unsupported`"). No
  round trip needed since `serverInfo` is already known from `connect()`.
- **`AuthDeniedError(scheme, cause: ApronError)`** -- thrown when the
  server's `auth` reply is specifically a `denied` (code `-32001`)
  `ApronError`. Wraps the original via the standard `Error` `cause`
  option (nothing lost; `err.cause.code`/`.message`/`.data` still work).
  Any *other* `ApronError` code (rate limiting, etc.) propagates
  unwrapped.

Deliberately NOT handled yet: §3.2's `signup` vs `auth` distinction (a
server that requires `guest` signup before a `token` sign-in) -- explicitly
deferred by the project owner; `authenticate()` only ever checks against
`serverInfo.auth`, never `serverInfo.signup`.

### Token persistence (`src/tokenCache.ts`)

Per Apron §3.2.1, the server may rotate the bearer token on any `auth`
reply, and "clients send a token only to the server address that they got
it from." `authenticate()`:

1. Calls `loadToken(config.configPath, config.serverUri)` first; falls
   back to `config.auth.token` (the TOML bootstrap value) only if nothing
   cached.
2. On a successful reply carrying `result.token`, calls
   `saveToken(config.configPath, config.serverUri, result.token)`.

Storage: a JSON file named `.cassie-bot-tokens.json`, living next to the
config file (same directory as `config.configPath`, via
`tokenCachePath()`), shaped `{ [serverUri: string]: string }`. Gitignored
(`.gitignore` has an explicit entry + comment). Deliberately NOT written
into the TOML config file itself -- that file is user-authored/plausibly
committed, and a rotating bearer credential must never end up in git
history alongside it.

`loadToken`/`saveToken` never throw on a missing/corrupt cache file --
that degrades to "no saved token" / "start the cache fresh," never a
fatal error. Read-modify-write, explicitly NOT atomic or safe for
concurrent writers -- acceptable, confirmed with the project owner, since
it's scoped to one bot process's own cache file.

### `onerror`/unmatched ids (deliberately deferred, revisit later)

- `socket.onerror` does nothing -- the WebSocket error event carries no
  useful detail; `onclose` (which always follows) is where cleanup
  actually happens.
- A reply frame whose `id` matches no pending request, or a frame with an
  unrecognized `method`, is `console.log`'d and otherwise ignored (not
  thrown) -- see `receiveMessage`.
- Both are intentionally left this way for now; flagged as a later
  improvement, not a bug.

## `src/registry.ts`, `src/types.ts`, `src/interfaces.ts`, `src/wire.ts`

- `src/registry.ts` -- see "Decided architecture" above; fully implemented
  and generic, `Registry<T>`.
- `src/types.ts` -- the three handler function types.
- `src/interfaces.ts` -- `IHandlerOptions`, `IRegistry<T>`,
  `IHandlerDescription`, `IChatMessage`, `IMessageContext`. All fully
  specified now (none of these are stub/empty interfaces anymore).
- `src/wire.ts` -- thin, partial, already-camelCase types for the Apron
  wire shapes `Bot` reads/builds directly: `IServerInfo` (§3.1 `server`
  frame), `IUser` (§3.3, partial), `IAuthResult` (§3.2). Deliberately not
  exhaustive -- only what's actually read/sent today.

## Built-in handlers (`src/handlers/`)

Registered by `handlerLoader.ts`'s `BUILTIN_HANDLERS` map, default-on
unless named in `config.disabled`:

- **`help`** (command *and* responder, `src/handlers/help.ts`) -- two
  separate registrations, since a server and/or its web UI may intercept
  a literal `/help`-shaped message before the bot ever sees it as a
  normal message:
  - the **command**: matches an exact `/help` message.
  - the **responder**: fires on an `@`-mention of the bot specifically
    (`ctx.message.mentions.includes(bot.you?.userId)`, not a text match
    on `@<name>` -- name can change, userId can't) combined with a
    case-insensitive substring check for `"help"` anywhere in the text
    (deliberately loose/unstrict for now, per the project owner). A
    mention with no `bot.you` set yet (pre-auth) is a safe no-op, not a
    crash.
  Both paths reply with the same markdown-formatted list of every
  registered command/responder (via `bot.listHandlers()`, filtered to
  exclude listeners) and its description.
- **`ethereum-price`** (responder, `src/handlers/ethereumPrice.ts`) --
  naive keyword match: both `"ethereum"` and `"price"` must appear
  anywhere in the message text (case-insensitive substring check, no word
  boundaries). Ignores the bot's own messages first
  (`ctx.message.from.userId === bot.you?.userId` -> immediate `false`) --
  without this it would re-trigger on its own price replies, and also on
  the `help` listing (which happens to contain both words). On a real
  match, fetches
  `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd`
  (plain `fetch`, no auth) and replies
  `"The current value of Ethereum is $<price>"`. Any failure (network
  error, bad JSON, missing/wrong-typed price field) replies with nothing
  and returns `false`, falling through to later responders -- no retry,
  no error message, no caching, deliberately fragile per the project
  owner's explicit ask. Originally asked for Binance; swapped to
  CoinGecko after confirming Binance's public API is geo-blocked
  ("Service unavailable from a restricted location") from at least one
  real vantage point.
- **`logging`** (listener, `src/handlers/logging.ts`) -- logs every
  message via `console.log`, formatted as
  `[<UTC timestamp>] [<room>] <from.name ?? from.userId>: <text>`, where
  `<room>` is `ctx.message.roomId ?? "default room"` (`roomId` is
  `undefined` for the server's one default room, not a real id to
  display). Written by the project owner themselves (not generated); two
  bugs caught in review and fixed collaboratively: the original listener
  returned `Promise<boolean>` instead of `void`, and interpolated the
  `from` object directly instead of extracting a name/userId string; the
  room was added after the fact once the owner noticed the log line never
  said which room a message came from.

## `src/handlerLoader.ts` -- loading built-ins + user handlers

`loadHandlers(bot: Bot): Promise<void>`:

1. Registers each `BUILTIN_HANDLERS` entry not named in
   `config.disabled`.
2. Resolves `<dirname(config.configPath)>/handlers/`, reads every `.ts`
   file directly inside it (sorted by filename, not recursive), and for
   each one: imports it via `jiti` (see below), requires a default export
   that's a function, and calls it with `bot`. A missing `handlers/`
   directory entirely is fine (`ENOENT` is caught and treated as "no
   custom handlers"); any other failure (bad default export, a throwing
   handler) fails the whole load loudly -- a bot silently missing a
   handler the operator asked for is a worse failure mode than a clear
   startup error.

### Running under Node vs. Bun

Bun can `import()` `.ts` files natively; plain Node (even >=22) cannot,
without a loader. Since this package is meant to be `npm install`-able by
consumers who may not be on Bun, `handlerLoader.ts` uses
[`jiti`](https://github.com/unjs/jiti) (a runtime dependency) to
transpile and `import()` the user's `handlers/*.ts` files regardless of
which runtime is actually running the bot. One `jiti` instance is reused
across all handler loads (it caches compiled output per file). Verified
directly (not just by green tests) under plain Node 26, not just Bun.

## `src/cli.ts` + `bin/cassie-bot.js` -- the actual CLI

- **`src/cli.ts`** -- `parseArgs(argv)` (reads `--config`/`-c`, throws a
  usage error if missing), `main()` (load config -> build `Bot` ->
  `loadHandlers` -> `connect` -> `authenticate` -> `postConnect` (room
  joins) -> log -> install shutdown handlers -- keeps running after that;
  the bot runs entirely off the socket's own events from then on), and
  `installShutdownHandlers(bot, exit?)` (SIGINT/SIGTERM ->
  `bot.disconnect()` + exit 0; a second signal mid-shutdown force-exits
  with 1 instead of disconnecting twice). `main` is never invoked as an
  import side effect -- only `bin/cassie-bot.js` calls it -- so the
  module stays safely importable by tests and by consumers composing
  their own bootstrap. A `RoomNotFoundError` thrown out of `postConnect`
  propagates up through `main` uncaught -- startup fails loudly with the
  available-rooms listing, by design (see `rooms` field above).
- **`bin/cassie-bot.js`** -- the actual npm/bun `bin` entry (plain JS,
  must be, since it runs before any of this package's own TS-loading
  machinery exists). Uses `jiti` to import and run `src/cli.ts`'s
  `main()`, with a top-level `.catch()` -> log + exit 1.
- **`src/index.ts`** -- the library's public entry point (distinct from
  the CLI): re-exports `Bot`, `Config`, `Registry`, the error classes
  (`ApronError`, `AuthDeniedError`, `UnsupportedSchemeError`),
  `loadHandlers`, the CLI pieces (`runCli` = `main`, `parseArgs`,
  `installShutdownHandlers`), `loadToken`/`saveToken`/`tokenCachePath`,
  and the public types/interfaces. Import-only, no logic of its own.

## Tests

`tests/` is a **top-level directory**, deliberately not alongside
implementation files (project owner's preference). All written against
Bun's built-in test runner (`bun:test`). Run via `bun test` or
`npm run test`. There's also a plain type-check (`bunx tsc --noEmit`),
worth running separately since `bun test` doesn't fail on type errors by
itself.

**130 tests passing** across 9 files, as of this writing (up from 102 --
the growth is room-joining, identity tracking, the `help` responder, and
associated bugfix coverage, all added this round):
- `tests/config.test.ts` -- `Config` defaults, `loadFromFile` round-trip/
  defaults/wrong-type-skips/missing-file-rejects, with TOML fixtures
  under `tests/fixtures/` (`full.toml`, `minimal.toml`,
  `invalid-types.toml`).
- `tests/registry.test.ts` -- `Registry<T>` register/unregister/
  duplicate-throws/re-register-after-unregister/`describe`/iteration
  order/`list()`.
- `tests/utils.test.ts` -- all 5 exports of `src/utils.ts`.
- `tests/bot.test.ts` -- the real websocket client, against
  `tests/fixtures/fake-websocket.ts` (a minimal `FakeWebSocket` stand-in,
  swapped in for the global `WebSocket` via `installFakeWebSocket()`):
  `connect`, `disconnect`, `authenticate` (success + token persistence +
  cached-token-wins-over-bootstrap + `AuthDeniedError` wrapping +
  non-denied `ApronError` passthrough + `UnsupportedSchemeError`
  pre-flight), `ping`, `sendMessage`, `receiveMessage` (including
  unmatched-id and unknown-method logging, and tombstones). Note:
  `authenticate()` now does a real async file read (token cache lookup)
  before sending its frame, so tests that need the sent frame must await
  a small `waitForSentFrame` poll helper rather than assuming it's sent
  synchronously.
- `tests/cli.test.ts` -- `parseArgs`, `installShutdownHandlers` (disconnect
  +exit on signal, second-signal force-exit without double-disconnect,
  `uninstall()` removing listeners so tests don't leak onto the real
  process).
- `tests/tokenCache.test.ts` -- `loadToken`/`saveToken`/`tokenCachePath`
  against real temp directories (`mkdtemp`/`tmpdir`, cleaned up in
  `afterEach`), covering missing-file/no-entry/corrupt-JSON/wrong-shape
  degrade-to-undefined, and create/overwrite-preserving-others/recover-
  from-corrupt for saves.
- `tests/handlers/help.test.ts`, `tests/handlers/ethereumPrice.test.ts`,
  `tests/handlers/logging.test.ts` -- each built-in's registration kind
  and matching logic. `help.test.ts` covers both of `help`'s
  registrations separately: the command's exact-match behavior, and the
  responder's six cases (registration; mention-without-"help" ignored;
  "help"-without-mention ignored; mention-of-someone-else ignored; a
  real case-insensitive match replies; no-op when `bot.you` isn't set
  yet). `ethereumPrice.test.ts` mocks `globalThis.fetch` rather than a
  real network call, and gained cases for its self-message-ignored
  bugfix (still replies to the same text from someone else, confirming
  the guard is identity-based, not content-based). `logging.test.ts`
  gained cases for its room-logging bugfix (room present vs. the
  "default room" fallback).

Tests that touch real files (`bot.test.ts`'s `authenticate` tests,
`tokenCache.test.ts`) are careful never to write into the repo's own
directory -- `bot.test.ts`'s `makeConfig()` uses a path under
`tests/fixtures/` (with an `afterEach` cleanup), `tokenCache.test.ts` uses
real OS temp directories.

## Dependencies

- `smol-toml` (runtime) -- TOML 1.0 parser, zero deps, ships its own
  types.
- `jiti` (runtime) -- transpiles/`import()`s arbitrary `.ts` at runtime,
  for both the CLI's own bootstrap and user `handlers/*.ts` files, under
  either Bun or plain Node.
- `@types/node` (runtime **dependency**, not dev -- see "TypeScript
  packaging" below for why) -- pinned `^22.0.0` to match
  `engines.node: ">=22"` rather than grabbing the newest major, so a
  consumer's `tsc` doesn't see Node APIs that may not exist on their
  actual (older-but-still->=22) runtime.
- `@types/bun` (dev), `typescript@^7` (peer) -- unchanged from initial
  scaffold.
- No other WebSocket library -- uses the global `WebSocket` (available
  natively in both Bun and Node >=22, hence the `engines.node: ">=22"`
  constraint in `package.json`).

## TypeScript packaging (consumer-facing, found via real end-to-end testing)

cassie-bot ships raw `.ts` source with no build/declaration step -- every
file's internals are visible to, and type-checked by, any consumer whose
`tsconfig.json` doesn't exclude `node_modules`. That surfaced three real
gaps, all found and fixed via an actual hand-rolled consumer project
(`../cassie-test`, a separate local directory symlinked into this repo's
`node_modules` -- not part of this repo -- used specifically to catch
this class of bug before publishing, since `bun test`/`tsc` from inside
cassie-bot itself can't see it):

- **`package.json` needs both `"main"` and `"types"`**, not just
  `"module"`. `"module"` is a bundler-only convention (esbuild/Vite/
  webpack read it to prefer ESM source); `tsc` itself never looks at it
  for module resolution, only `"types"`/`"typings"` then `"main"`. A
  consumer's `tsc` saw `@toastdriven/cassie-bot` as entirely unresolvable
  until both were added, even though `jiti` (a bundler-like runtime
  loader) resolved it fine the whole time -- the break was type-checking
  only, never runtime.
- **Internal relative imports use a literal `.js` extension, not `.ts`,
  not extensionless** (`import { Config } from './config.js'` in a file
  that is itself `.ts`). This looks wrong on first read but is the
  TypeScript-sanctioned pattern for exactly this situation: under
  `moduleResolution: "nodenext"`/`"node16"` (common in a strict consumer
  tsconfig, not cassie-bot's own which uses `"bundler"`), `tsc` is
  specifically designed to resolve a `./foo.js` specifier to a sibling
  `./foo.ts` file. A literal `.ts` extension only type-checks under the
  `allowImportingTsExtensions` flag, which lives in cassie-bot's own
  tsconfig and is never inherited by a consumer -- so it looked right
  from inside this repo and was silently broken for every consumer.
  Verified resolving correctly under `tsc`, `jiti`, and `bun run`
  directly (all three) before converting every internal import across
  `bot.ts`, `cli.ts`, `handlerLoader.ts`, `index.ts`, `registry.ts`,
  `types.ts`, and the three built-in handlers.
- **`@types/node` must be a real `dependency`**, not `devDependency` --
  a `devDependency` isn't installed at all for a downstream consumer, so
  a consumer's `tsc` hit `Cannot find name 'process'`/`node:fs`/etc.
  pointing at cassie-bot's own source. Verified via an actual
  `npm pack` + fresh install in a scratch directory that npm correctly
  hoists it to the consumer's own top-level `node_modules/@types/node`.

**A related gotcha worth documenting for end users** (now in the
README's "A note on TypeScript" section, under Quickstart): if a
consumer's own `tsconfig.json` sets `"types": []` (TypeScript's
"Node.js" quickstart template includes this, commented out, as a
starting point -- `../cassie-test` hit this exact thing), that
explicitly opts *out* of all ambient `@types/*` auto-inclusion, even
ones that are genuinely installed. The fix is on the consumer's side
(`"types": ["node"]`), not something cassie-bot can force from the
dependency side -- a library can't inject ambient globals into a
consumer that's explicitly opted out of them.

Also fixed during the same pass, unrelated to the above but caught by
the same real-consumer `tsc` run: four `exactOptionalPropertyTypes`
mismatches in `bot.ts` (`mergeUser`'s `name`/`roles`, `RoomNotFoundError`
room listing's `title`, `ctx.reply`'s `roomId`/`format`) -- all were
building object literals that always assigned an optional key (possibly
to `undefined`) instead of conditionally spreading it in only when
defined. Invisible from inside cassie-bot (its own tsconfig doesn't set
`exactOptionalPropertyTypes`), only surfaced once checked under a
consumer tsconfig stricter than cassie-bot's own.

## Current state / what's genuinely still open

Everything in "Goal" above is implemented and tested, end to end. What's
explicitly still unbuilt or deferred (don't assume these are done without
checking the actual file):

- **`handlers: string[]`** config field is parsed but unused -- reserved
  for a future "named installed package" mechanism.
- **Reconnect/liveness policy** -- no auto-reconnect at all; a dropped
  connection just stays dropped. No handling of `retry_after`-style
  backoff. Flagged by the project owner as the next thing to dig into.
- **`signup` vs `auth` two-step flows** (Apron §3.2) -- not supported;
  `authenticate()` only ever validates against `serverInfo.auth`.
- **`socket.onerror`** -- still a no-op by design (see above), not yet
  revisited.
- **Package not actually published yet** -- metadata is in place
  (`@toastdriven/cassie-bot`, version `0.2.0`, license, repo URL,
  `private` removed from `package.json`), but confirm with the project
  owner before running `npm publish` for real.

## Working style for this project (from the human partner)

- Step-by-step, not racing ahead -- implement what's asked, don't
  pre-build the rest. Don't "fix" in-progress files the human is actively
  editing without checking first.
- This is a learning project for them: their TypeScript is rusty and
  they didn't know server-side WebSocket handling at the start, so
  explanations alongside implementation are wanted, not just code dumped
  in.
- They want a real hand in writing it, not just reviewing fully-generated
  code -- e.g. they wrote `src/handlers/logging.ts` themselves (a real
  bug in it, a listener returning `Promise<boolean>` instead of `void`,
  was caught and fixed collaboratively, not silently).
- Watch for over-engineering ("architecture astronaut" tendency was
  self-flagged) -- prefer the simplest structure that fits the known
  extension kinds over speculative generality (e.g. a generic registry
  with an `options` bag for pattern/command-name customization was
  considered and explicitly dropped as unneeded complexity).
- Tests belong in a top-level `tests/` directory, not alongside
  implementation files.
- When adding a new built-in or feature, the expected cadence is:
  implement -> `tsc --noEmit` clean -> write/port tests -> run the full
  suite -> flag any design discrepancy noticed along the way (e.g. the
  "replaces" vs. "throws" `Registry.register` mismatch caught while
  writing the README) rather than silently fixing docs to match
  behavior, or vice versa, without surfacing it first.
