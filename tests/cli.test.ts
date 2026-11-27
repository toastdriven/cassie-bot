import { describe, expect, test } from "bun:test";
import { installShutdownHandlers, parseArgs } from "../src/cli";
import { Bot } from "../src/bot";
import { Config } from "../src/config";

describe("parseArgs", () => {
  test("parses --config <path>", () => {
    expect(parseArgs(["--config", "./bot.toml"])).toEqual({ configPath: "./bot.toml" });
  });

  test("parses -c <path> as a shorthand", () => {
    expect(parseArgs(["-c", "./bot.toml"])).toEqual({ configPath: "./bot.toml" });
  });

  test("throws when --config is missing entirely", () => {
    expect(() => parseArgs([])).toThrow();
  });

  test("throws when --config has no value after it", () => {
    expect(() => parseArgs(["--config"])).toThrow();
  });
});

function makeBot(): Bot {
  const config = new Config("./bot.toml");
  config.serverUri = "wss://example.test/ws";
  return new Bot(config);
}

describe("installShutdownHandlers", () => {
  test("a signal disconnects the bot and exits 0", () => {
    const bot = makeBot();
    let disconnected = false;
    bot.disconnect = () => {
      disconnected = true;
    };

    const exitCodes: number[] = [];
    const uninstall = installShutdownHandlers(bot, (code) => exitCodes.push(code));

    process.emit("SIGINT", "SIGINT");

    expect(disconnected).toBe(true);
    expect(exitCodes).toEqual([0]);

    uninstall();
  });

  test("a second signal during shutdown force-exits with code 1 instead of disconnecting again", () => {
    const bot = makeBot();
    let disconnectCalls = 0;
    bot.disconnect = () => {
      disconnectCalls += 1;
    };

    const exitCodes: number[] = [];
    const uninstall = installShutdownHandlers(bot, (code) => exitCodes.push(code));

    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");

    expect(disconnectCalls).toBe(1);
    expect(exitCodes).toEqual([0, 1]);

    uninstall();
  });

  test("uninstall removes the listeners so a later signal has no effect", () => {
    const bot = makeBot();
    let disconnected = false;
    bot.disconnect = () => {
      disconnected = true;
    };

    const exitCodes: number[] = [];
    const uninstall = installShutdownHandlers(bot, (code) => exitCodes.push(code));
    uninstall();

    process.emit("SIGINT", "SIGINT");

    expect(disconnected).toBe(false);
    expect(exitCodes).toEqual([]);
  });
});
