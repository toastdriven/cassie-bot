# cassie-bot

A flexible/extensible chat bot that speaks the Apron protocol.

Cassie is short for _"casserole"_, a dish with a million variants/customizations,
& which goes great in the kitchen with your [Apron](https://apron.chat/).

## Quickstart

1. Make a directory for your bot
2. Install `cassie-bot`
   a. _e.g._ `npm install @toastdriven/cassie-bot`
3. Create a `bot.toml` configuration file (based off the below)
4. If you want to create your own listeners/commands/responders, create a `handlers`
   directory next to the `bot.toml`.
5. Run the bot with `cassie-bot --config bot.toml`

## Config File

`bot.toml` is a plain [TOML](https://toml.io/) file. Every key below except
`serverUri` has a default, so a minimal file only needs that one:

```toml
serverUri = "wss://chat.example/ws"
```

A fully-populated file looks like this:

```toml
botName = "cassie"                  # default: "cassie-bot"
serverUri = "wss://chat.example/ws" # required; no default
agent = "cassie-bot/0.1"            # default: "cassie-bot/0.1"
rooms = ["general", "ops"]          # default: [] (the server's single default room)
handlers = ["metar", "giphy"]       # reserved for future use; see below
disabled = ["help"]                 # default: [] -- built-in names to turn off

[auth]
scheme = "token"       # one of the server's advertised schemes (Apron §3.2)
token = "secret-token" # bootstrap credential for scheme = "token"; see below
```

- **`botName`** -- the display name the bot requests for itself with the
  server (sent as `name` in the `auth` request). The server has final say;
  it may assign something else.
- **`serverUri`** -- the `wss://`/`ws://` address to connect to. The only
  field with no sensible default.
- **`agent`** -- an implementation/version string sent with `auth`, purely
  for the server's own debugging (Apron §3.2). Change it if you fork/rename
  your bot and want that visible server-side.
- **`rooms`** -- rooms to join on startup. Only meaningful if the server
  advertises the `"rooms"` capability (Apron §3.4/§4.2); a server without
  it has exactly one default room and no `room_join` at all.
- **`handlers`** -- reserved for naming an npm-installed handler *package*
  (as opposed to a file in your own `handlers/` directory, or a built-in).
  Not implemented yet.
- **`disabled`** -- names of cassie-bot's own built-in handlers to turn
  off. Registering two handlers under the same name (within the same
  kind) is an error -- `Registry.register` throws rather than silently
  replacing the first one. So to *replace* a built-in with your own (e.g.
  your own `/help`), you need **both**: list its name in `disabled`, and
  register your own handler under that same name from your `handlers/`
  directory.
- **`[auth]`** -- how the bot signs in (Apron §3.2):
  - `scheme` must be one of the schemes the server actually advertises in
    its greeting. Realistically `"guest"` or `"token"` for a bot --
    `"webauthn"`, `"email"`, and `"external"` are all built around a human
    clicking through a browser flow, not something a headless bot can
    drive. `authenticate()` checks this before sending anything and fails
    fast (`UnsupportedSchemeError`) if the server doesn't offer it.
  - `token` is only the *bootstrap* credential for `scheme = "token"`.
    Per Apron §3.2.1 the server may rotate the token on any `auth` reply;
    cassie-bot saves the latest one to a gitignored
    `.cassie-bot-tokens.json` file next to `bot.toml` and uses that
    automatically on later runs, so you'll typically only need this field
    for the very first connection (or if you ever delete the cache file).

## Writing Custom Handlers

Drop a `.ts` file directly inside a `handlers/` directory next to your
`bot.toml`, and export a default function that takes the `Bot` instance.
Every file in that directory loads unconditionally -- there's no separate
enable list to maintain; adding the file *is* enabling it. Inside that
function, call one of `bot.registerListener`, `bot.registerCommand`, or
`bot.registerResponder` depending on which kind of handler you're writing
(you can call more than one, or more than once, from the same file).

All three take the same shape:

```ts
register<Kind>(name: string, options: { description?: string } | undefined, func: Handler): void
```

- **`name`** -- a unique identifier within that handler kind. Used by
  `disabled` (for built-ins) and shown by `/help`. Registering a second
  handler under a name already in use for that kind **throws** -- names
  must be unique per kind, so swapping out a built-in for your own
  version (e.g. your own `/help`) needs its name listed in `disabled` as
  well as a handler registered under that same name.
- **`options.description`** -- a short, human-readable line shown by the
  built-in `/help` command. Optional, but worth including.
- **`func`** -- the handler itself; see each kind below for its exact
  signature.

Every handler receives an `IMessageContext`, which carries the incoming
message (`ctx.message`, already normalized to camelCase -- see
[`src/interfaces.ts`](src/interfaces.ts) for the full shape) and a
`ctx.reply(text, options?)` method that sends a new message back to the
same room the incoming one arrived in.

The bot does no detection of commands or keywords itself -- it just hands
every incoming message, in order, to listeners, then commands, then
responders, and lets each handler decide for itself whether it's relevant.

### Listeners

Run on *every* message, always, regardless of what any other listener
does. Never claim a message -- their return value is ignored, so they're
for side effects only (logging, metrics, archiving, ...), never a reply.

```ts
import { Bot } from "@toastdriven/cassie-bot";
import type { IMessageContext } from "@toastdriven/cassie-bot";

export default function (bot: Bot): void {
  bot.registerListener(
    "logging",
    { description: "Logs every message to stdout." },
    (ctx: IMessageContext): void => {
      console.log(`${ctx.message.from.name ?? ctx.message.from.userId}: ${ctx.message.text}`);
    },
  );
}
```

See the built-in [`src/handlers/logging.ts`](src/handlers/logging.ts) for
a real example.

### Commands

Run after all listeners, in registration order, for one-off `/command`
style interactions. Return `true` if the handler recognized and handled
the message (dispatch stops there -- no other command or responder runs),
or `false` to let the next one have a look.

```ts
import { Bot } from "@toastdriven/cassie-bot";
import type { IMessageContext } from "@toastdriven/cassie-bot";

export default function (bot: Bot): void {
  bot.registerCommand(
    "/ping",
    { description: "Replies with pong." },
    async (ctx: IMessageContext): Promise<boolean> => {
      if (ctx.message.text.trim() !== "/ping") {
        return false;
      }
      await ctx.reply("pong");
      return true;
    },
  );
}
```

See the built-in [`src/handlers/help.ts`](src/handlers/help.ts) for a
real example that lists every registered command/responder.

### Responders

Run last, only if no command claimed the message, for simple keyword- or
pattern-based replies. Same `true`/`false`, stop-on-first-match contract
as commands.

```ts
import { Bot } from "@toastdriven/cassie-bot";
import type { IMessageContext } from "@toastdriven/cassie-bot";

export default function (bot: Bot): void {
  bot.registerResponder(
    "needs-help",
    { description: "Points at the docs when someone says they need help." },
    async (ctx: IMessageContext): Promise<boolean> => {
      if (!ctx.message.text.toLowerCase().includes("need help")) {
        return false;
      }
      await ctx.reply("Check out the docs: https://example.com/docs");
      return true;
    },
  );
}
```

See the built-in
[`src/handlers/ethereumPrice.ts`](src/handlers/ethereumPrice.ts) for a
real (deliberately naive) example that calls out to an external API
before replying.

## Running Tests

Tests are written against [Bun's](https://bun.sh/) built-in test runner
and live under `tests/`, mirroring the structure of `src/` (e.g.
`tests/handlers/` for the built-in handlers' own tests).

```sh
bun install
bun test
```

There's also a plain type-check, useful since `bun test` doesn't fail on
type errors by itself:

```sh
bunx tsc --noEmit
```

## Author

Daniel Lindsley & Claude

## License

New BSD (3-Clause)
