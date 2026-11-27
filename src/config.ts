import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

export class Config {
  configPath: string;
  botName: string = "cassie-bot";
  serverUri: string = "";

  // Implementation-string for the "agent" field on the server frame/auth
  // request (Apron §3.1/§3.2), purely for debugging on the server's end.
  agent: string = "cassie-bot/0.1";

  // auth.scheme picks one of the server's advertised auth schemes (Apron
  // §3.2). Realistically "guest" or "token" for a bot -- "webauthn",
  // "email", and "external" are all built around a human clicking through
  // a browser flow, not something a headless bot can drive on its own.
  // auth.token is only the *bootstrap* credential for "token": per §3.2.1
  // the server may rotate the token on each reply, and the client is
  // expected to save the latest one for future connections.
  // Once a token is rotated by the server, this bootstrap value goes
  // stale -- Bot.authenticate() reads/writes a separate (gitignored)
  // token-cache file at runtime instead (see tokenCache.ts), falling
  // back to this field only when no cached token exists yet.
  auth: { scheme: string; token?: string } = { scheme: "guest" };

  // Names of rooms to join on startup, matched against the server's
  // room_list by title (case-insensitively) or, failing that, by raw
  // room_id -- see Bot.postConnect(). Only meaningful if the server
  // advertises capability "rooms" (Apron §3.4/§4.2); without it there's
  // exactly one default room and no room_join. postConnect() checks
  // server.capabilities itself and warns + no-ops if this list is
  // non-empty but the server lacks that capability.
  rooms: string[] = [];

  // Built-in + installed handlers to enable, by name.
  handlers: string[] = [];
  // Built-in handlers names to turn off, with no replacement. (A file in
  // the handlers directory that re-registers a built-in's name, e.g. a
  // custom "help" command, overrides it directly via the Registry and
  // doesn't need to appear here.)
  disabled: string[] = [];

  // TODO: reconnect/liveness policy. The spec has real rules worth
  // exposing knobs for later: honor server.ping's interval (§1), don't
  // auto-reconnect after a `denied` error, wait out `retry_after` before
  // reconnecting (§1.1).

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  // Reads and parses a TOML config file, and returns a new, populated
  // Config. This is a *static* factory rather than an instance method:
  // reading a file is async, and a constructor can't be async, so there's
  // no way for `new Config(...)` itself to do the loading. Call it as
  // `const config = await Config.loadFromFile("./bot.toml")`.
  static async loadFromFile(configPath: string): Promise<Config> {
    const raw = await readFile(configPath, "utf-8");
    const data = parse(raw);

    const config = new Config(configPath);

    if (typeof data.botName === "string") {
      config.botName = data.botName;
    }
    if (typeof data.serverUri === "string") {
      config.serverUri = data.serverUri;
    }
    if (typeof data.agent === "string") {
      config.agent = data.agent;
    }
    if (isAuthTable(data.auth)) {
      config.auth = {
        scheme: data.auth.scheme,
        ...(typeof data.auth.token === "string" ? { token: data.auth.token } : {}),
      };
    }
    if (isStringArray(data.rooms)) {
      config.rooms = data.rooms;
    }
    if (isStringArray(data.handlers)) {
      config.handlers = data.handlers;
    }
    if (isStringArray(data.disabled)) {
      config.disabled = data.disabled;
    }

    return config;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAuthTable(value: unknown): value is { scheme: string; token?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    typeof (value as { scheme: unknown }).scheme === "string"
  );
}
