#!/usr/bin/env node
import { Bot } from "./bot";
import { Config } from "./config";
import { loadHandlers } from "./handlerLoader";

// The actual `cassie-bot` executable (see package.json's "bin" field):
// `cassie-bot --config ./bot.toml`. Everything here is orchestration --
// the pieces it calls (Bot, Config, loadHandlers) have no CLI awareness
// of their own, so a consumer who wants a different bootstrap (a
// supervisor process, a test harness, ...) can import those directly from
// cassie-bot's library entry point (src/index.ts) instead of running this.

export function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.findIndex((arg) => arg === "--config" || arg === "-c");
  const configPath = flagIndex === -1 ? undefined : argv[flagIndex + 1];

  if (!configPath) {
    throw new Error("Usage: cassie-bot --config <path-to-bot.toml>");
  }

  return { configPath };
}

// Not run as a side effect of importing this file -- see bin/cassie-bot.js,
// the only caller. Keeping this file side-effect-free on import is what
// lets tests import parseArgs/installShutdownHandlers from it directly
// without accidentally starting a real bot.
export async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));

  const config = await Config.loadFromFile(configPath);
  const bot = new Bot(config);

  await loadHandlers(bot);

  await bot.connect();
  await bot.authenticate();
  await bot.postConnect();

  console.log(`cassie-bot: connected to ${config.serverUri} as ${bot.you?.userId ?? "(unknown)"}`);

  // Keep the process alive -- there's nothing left to await; the bot now
  // runs entirely off the socket's own message events. Shutdown is via
  // the signal handlers below, not by this function returning.
  installShutdownHandlers(bot);
}

// SIGINT (Ctrl-C) and SIGTERM (e.g. `systemctl stop`, `docker stop`) both
// mean "please stop" -- disconnect cleanly (closes the socket, which per
// Bot._handleClose also stops the ping timer and fails any in-flight
// request, though none should be in flight at idle) rather than just
// dying and leaving the connection to time out on the server's end.
//
// A second signal while that's already in progress means the operator
// wants out *now* -- force-exit rather than risk hanging if disconnect()
// itself never settles.
//
// `exit` defaults to process.exit, overridable so tests can assert on
// shutdown behavior without actually killing the test process. Returns an
// uninstall function (removes both listeners) for the same reason --
// tests shouldn't leak SIGINT/SIGTERM handlers onto the real process.
export function installShutdownHandlers(
  bot: Bot,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.log(`cassie-bot: received ${signal} again, forcing exit`);
      exit(1);
      return;
    }
    shuttingDown = true;

    console.log(`cassie-bot: received ${signal}, disconnecting`);
    bot.disconnect();
    exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}
