import { describe, expect, test } from "bun:test";
import { Bot } from "../../src/bot";
import { Config } from "../../src/config";
import registerHelp from "../../src/handlers/help";
import type { IChatMessage, IMessageContext } from "../../src/interfaces";

function makeBot(): Bot {
  const config = new Config("./bot.toml");
  config.serverUri = "wss://example.test/ws";
  return new Bot(config);
}

// A minimal IMessageContext stand-in -- records what reply() was called
// with, so tests can assert on it without a real/fake websocket.
function makeContext(text: string, mentions: string[] = []): IMessageContext & { replies: string[] } {
  const replies: string[] = [];
  const message: IChatMessage = {
    text,
    format: "plain",
    from: { userId: "alice" },
    mentions,
  };

  return {
    message,
    replies,
    reply: async (replyText: string) => {
      replies.push(replyText);
    },
  };
}

describe("help command", () => {
  test("registers itself as a command named /help", () => {
    const bot = makeBot();
    registerHelp(bot);

    const described = bot.listHandlers().find((h) => h.name === "/help");
    expect(described).toBeDefined();
    expect(described?.kind).toBe("command");
  });

  test("ignores a message that is not exactly /help", async () => {
    const bot = makeBot();
    registerHelp(bot);
    const ctx = makeContext("/help me please");

    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("replies with a listing of registered commands/responders, excluding listeners", async () => {
    const bot = makeBot();
    registerHelp(bot);
    bot.registerCommand("/metar", { description: "Looks up a METAR" }, () => true);
    bot.registerResponder("needs-help", { description: "Links to docs" }, () => true);
    bot.registerListener("logger", { description: "Logs every message" }, () => {});

    const ctx = makeContext("/help");
    await bot.onMessage(ctx);

    expect(ctx.replies).toHaveLength(1);
    const body = ctx.replies[0]!;
    expect(body).toContain("/metar");
    expect(body).toContain("Looks up a METAR");
    expect(body).toContain("needs-help");
    expect(body).toContain("Links to docs");
    expect(body).not.toContain("logger");
  });

  test("falls back to 'no description' for a handler registered without one", async () => {
    const bot = makeBot();
    registerHelp(bot);
    bot.registerCommand("/ping", undefined, () => true);

    const ctx = makeContext("/help");
    await bot.onMessage(ctx);

    expect(ctx.replies[0]).toContain("/ping");
    expect(ctx.replies[0]).toContain("no description");
  });

  test("replies with a 'nothing registered' message when only itself is registered and it's excluded", async () => {
    // /help itself is a command, so it's always included in its own
    // listing -- this test documents that rather than asserting an empty
    // list, since /help can never truly be "the only listener excluded".
    const bot = makeBot();
    registerHelp(bot);

    const ctx = makeContext("/help");
    await bot.onMessage(ctx);

    expect(ctx.replies[0]).toContain("/help");
    expect(ctx.replies[0]).toContain("Available commands/responders:");
  });

  test("returns true (claims the message) only when it matches", async () => {
    const bot = makeBot();
    registerHelp(bot);

    const matching = makeContext("/help");
    const notMatching = makeContext("/other");

    // onMessage doesn't expose the boolean directly, so assert indirectly:
    // a claimed command stops the pipeline before responders run.
    let responderRan = false;
    bot.registerResponder("marker", undefined, () => {
      responderRan = true;
      return true;
    });

    await bot.onMessage(matching);
    expect(responderRan).toBe(false);

    responderRan = false;
    await bot.onMessage(notMatching);
    expect(responderRan).toBe(true);
  });
});

describe("help responder", () => {
  test("registers itself as a responder named 'help'", () => {
    const bot = makeBot();
    registerHelp(bot);

    const described = bot.listHandlers().find((h) => h.name === "help" && h.kind === "responder");
    expect(described).toBeDefined();
  });

  test("ignores a message that mentions the bot but doesn't say 'help'", async () => {
    const bot = makeBot();
    bot.you = { userId: "cassie", name: "cassie-bot" };
    registerHelp(bot);

    const ctx = makeContext("@cassie-bot good morning", ["cassie"]);
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("ignores a message that says 'help' but doesn't mention the bot", async () => {
    const bot = makeBot();
    bot.you = { userId: "cassie", name: "cassie-bot" };
    registerHelp(bot);

    const ctx = makeContext("can someone help me", []);
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("ignores a message that mentions some other user, even if it says 'help'", async () => {
    const bot = makeBot();
    bot.you = { userId: "cassie", name: "cassie-bot" };
    registerHelp(bot);

    const ctx = makeContext("@alice can you help?", ["alice"]);
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("replies with the handler listing when mentioned and 'help' is said, case-insensitively", async () => {
    const bot = makeBot();
    bot.you = { userId: "cassie", name: "cassie-bot" };
    registerHelp(bot);
    bot.registerResponder("metar", { description: "Looks up a METAR" }, () => false);

    const ctx = makeContext("@cassie-bot: HELP", ["cassie"]);
    await bot.onMessage(ctx);

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain("metar");
  });

  test("does nothing if bot.you hasn't been set yet (not authenticated)", async () => {
    const bot = makeBot();
    registerHelp(bot);

    const ctx = makeContext("@cassie-bot help", ["cassie"]);
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });
});
