import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "../../src/bot";
import { Config } from "../../src/config";
import registerEthereumPrice from "../../src/handlers/ethereumPrice";
import type { IChatMessage, IMessageContext } from "../../src/interfaces";

function makeBot(): Bot {
  const config = new Config("./bot.toml");
  config.serverUri = "wss://example.test/ws";
  return new Bot(config);
}

function makeContext(text: string): IMessageContext & { replies: string[] } {
  const replies: string[] = [];
  const message: IChatMessage = {
    text,
    format: "plain",
    from: { userId: "alice" },
    mentions: [],
  };

  return {
    message,
    replies,
    reply: async (replyText: string) => {
      replies.push(replyText);
    },
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchJson(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

function mockFetchFailure(): void {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

describe("ethereum-price responder", () => {
  test("registers itself as a responder", () => {
    const bot = makeBot();
    registerEthereumPrice(bot);

    const described = bot.listHandlers().find((h) => h.name === "ethereum-price");
    expect(described).toBeDefined();
    expect(described?.kind).toBe("responder");
  });

  test("ignores a message mentioning only one of the two keywords", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchJson({ ethereum: { usd: 1234.5 } });

    const ctx = makeContext("what's the price of bitcoin?");
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("ignores a message mentioning neither keyword", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchJson({ ethereum: { usd: 1234.5 } });

    const ctx = makeContext("hello there");
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("replies with the fetched price when both keywords are mentioned, case-insensitively", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchJson({ ethereum: { usd: 1234.5 } });

    const ctx = makeContext("What's the PRICE of Ethereum right now?");
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual(["The current value of Ethereum is $1234.5"]);
  });

  test("replies nothing if the fetch throws", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchFailure();

    const ctx = makeContext("ethereum price?");
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("replies nothing if the response is missing the expected price field", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchJson({ ethereum: {} });

    const ctx = makeContext("ethereum price?");
    await bot.onMessage(ctx);

    expect(ctx.replies).toEqual([]);
  });

  test("returns true (claims the message) only when it replies", async () => {
    const bot = makeBot();
    registerEthereumPrice(bot);
    mockFetchJson({ ethereum: { usd: 1234.5 } });

    let laterResponderRan = false;
    bot.registerResponder("marker", undefined, () => {
      laterResponderRan = true;
      return true;
    });

    await bot.onMessage(makeContext("ethereum price?"));
    expect(laterResponderRan).toBe(false);

    laterResponderRan = false;
    await bot.onMessage(makeContext("hello there"));
    expect(laterResponderRan).toBe(true);
  });
});
