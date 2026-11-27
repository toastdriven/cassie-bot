// The library's public entry point (see package.json's "module" field).
// A consumer who wants to write their own bootstrap script, instead of
// using the cassie-bot CLI (bin/cassie-bot -> src/cli.ts), imports from
// here: `import { Bot, Config } from "cassie-bot"`.
//
// This file intentionally re-exports only, no logic -- the CLI's own
// connect/authenticate/load-handlers/shutdown orchestration lives in
// cli.ts, not here, so it stays optional for anyone building their own
// entrypoint.

export { Bot } from "./bot";
export { Config } from "./config";
export { Registry } from "./registry";
export { ApronError, AuthDeniedError, RoomNotFoundError, UnsupportedSchemeError } from "./errors";
export { loadHandlers } from "./handlerLoader";
export { installShutdownHandlers, main as runCli, parseArgs } from "./cli";
export { loadToken, saveToken, tokenCachePath } from "./tokenCache";

export type {
  IChatMessage,
  IHandlerDescription,
  IHandlerOptions,
  IMessageContext,
  IRegistry,
} from "./interfaces";
export type { CommandHandler, ListenerHandler, ResponderHandler } from "./types";
export type { IAuthResult, IServerInfo, IUser } from "./wire";
