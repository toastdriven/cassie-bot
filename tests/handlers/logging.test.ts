import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Bot } from "../../src/bot";
import { Config } from "../../src/config";
import registerLogging from "../../src/handlers/logging";
import type { IChatMessage, IMessageContext } from "../../src/interfaces";

function makeBot(): Bot {
  const config = new Config("./bot.toml");
  config.serverUri = "wss://example.test/ws";
  return new Bot(config);
}

function makeContext(message: Partial<IChatMessage> & { text: string }): IMessageContext {
  const fullMessage: IChatMessage = {
    text: message.text,
    format: message.format ?? "plain",
    from: message.from ?? { userId: "alice" },
    mentions: message.mentions ?? [],
    ...(message.roomId ? { roomId: message.roomId } : {}),
  };

  return {
    message: fullMessage,
    reply: async () => {
      throw new Error("logging listener should never call reply()");
    },
  };
}

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("logging listener", () => {
  test("registers itself as a listener named logging", () => {
    const bot = makeBot();
    registerLogging(bot);

    const described = bot.listHandlers().find((h) => h.name === "logging");
    expect(described).toBeDefined();
    expect(described?.kind).toBe("listener");
  });

  test("logs every message, regardless of content", async () => {
    const bot = makeBot();
    registerLogging(bot);

    await bot.onMessage(makeContext({ text: "hello there" }));

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test("logs the message text and the sender's name when present", async () => {
    const bot = makeBot();
    registerLogging(bot);

    await bot.onMessage(
      makeContext({ text: "hi", from: { userId: "alice", name: "Alice" } }),
    );

    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("Alice");
    expect(logged).toContain("hi");
  });

  test("falls back to userId when the sender has no name", async () => {
    const bot = makeBot();
    registerLogging(bot);

    await bot.onMessage(makeContext({ text: "hi", from: { userId: "bob" } }));

    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("bob");
  });

  test("logs the roomId when the message carries one", async () => {
    const bot = makeBot();
    registerLogging(bot);

    await bot.onMessage(makeContext({ text: "hi", roomId: "test-kitchen" }));

    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("test-kitchen");
  });

  test("logs a 'default room' label when roomId is absent", async () => {
    const bot = makeBot();
    registerLogging(bot);

    await bot.onMessage(makeContext({ text: "hi" }));

    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("default room");
  });

  test("never claims the message -- later commands/responders still run", async () => {
    const bot = makeBot();
    registerLogging(bot);

    let commandRan = false;
    bot.registerCommand("marker", undefined, () => {
      commandRan = true;
      return true;
    });

    await bot.onMessage(makeContext({ text: "/marker" }));

    expect(commandRan).toBe(true);
  });

  test("runs alongside other listeners -- does not stop the listener pipeline", async () => {
    const bot = makeBot();
    registerLogging(bot);

    let otherListenerRan = false;
    bot.registerListener("marker", undefined, () => {
      otherListenerRan = true;
    });

    await bot.onMessage(makeContext({ text: "hi" }));

    expect(otherListenerRan).toBe(true);
  });
});
