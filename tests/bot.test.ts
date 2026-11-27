import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Bot } from "../src/bot";
import { Config } from "../src/config";
import { ApronError, AuthDeniedError, RoomNotFoundError, UnsupportedSchemeError } from "../src/errors";
import { tokenCachePath } from "../src/tokenCache";
import { FakeWebSocket, installFakeWebSocket } from "./fixtures/fake-websocket";

// authenticate() reads/writes a token cache file next to configPath (see
// tokenCache.ts) -- route it at a fixtures path, never at the repo's own
// directory, so running this suite never writes a stray
// .cassie-bot-tokens.json alongside package.json.
function makeConfig(): Config {
  const config = new Config(join(import.meta.dir, "fixtures", "bot.toml"));
  config.serverUri = "wss://example.test/ws";
  config.botName = "cassie-test";
  return config;
}

// authenticate() now does a real (async) file read before sending the
// auth frame -- so, unlike the other _sendRequest-based calls in this
// file, the frame isn't on the wire synchronously after calling it.
// Poll briefly rather than assume a fixed number of microtask ticks.
async function waitForSentFrame(socket: FakeWebSocket, previousCount = 0): Promise<void> {
  const deadline = Date.now() + 1000;
  while (socket.sent.length <= previousCount) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a frame to be sent");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// The frame the server sends immediately on accept (Apron §3.1). Advertises
// both schemes exercised in this file's authenticate() tests, so the
// pre-flight scheme check in Bot.authenticate() doesn't reject them.
const SERVER_GREETING = JSON.stringify({
  method: "server",
  params: { apron: 10, auth: ["guest", "token"] },
});

let restoreWebSocket: () => void;

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
});

describe("Bot.connect", () => {
  test("resolves with the server frame once it arrives", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe("wss://example.test/ws");
    socket.emitMessage(SERVER_GREETING);

    const info = await connecting;
    expect(info).toEqual({ apron: 10, auth: ["guest", "token"] });
    expect(bot.serverInfo).toEqual({ apron: 10, auth: ["guest", "token"] });
  });

  test("throws synchronously if called while already connected", () => {
    const bot = new Bot(makeConfig());
    void bot.connect();

    expect(() => bot.connect()).toThrow();
  });

  test("starts a ping timer when the server frame advertises one", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;

    socket.emitMessage(
      JSON.stringify({ method: "server", params: { apron: 10, auth: ["guest"], ping: 30 } }),
    );
    await connecting;

    expect(bot._pingTimer).not.toBeUndefined();
  });

  test("does not start a ping timer when the server frame omits ping", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;

    socket.emitMessage(SERVER_GREETING);
    await connecting;

    expect(bot._pingTimer).toBeUndefined();
  });
});

describe("Bot.disconnect", () => {
  test("closes the socket and clears connection state", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitMessage(SERVER_GREETING);
    await connecting;

    bot.disconnect();

    expect(bot.socket).toBeUndefined();
    expect(bot.serverInfo).toBeUndefined();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  test("rejects any request still waiting on a reply", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitMessage(SERVER_GREETING);
    await connecting;

    const sendPromise = bot.sendMessage("hello");
    bot.disconnect();

    await expect(sendPromise).rejects.toThrow();
  });

  test("stops the ping timer", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitMessage(
      JSON.stringify({ method: "server", params: { apron: 10, auth: ["guest"], ping: 30 } }),
    );
    await connecting;

    bot.disconnect();

    expect(bot._pingTimer).toBeUndefined();
  });

  test("a connection closed by the server (not disconnect()) also rejects the pending connect", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitClose();

    await expect(connecting).rejects.toThrow();
  });
});

describe("Bot.authenticate", () => {
  // authenticate() persists a rotated token to a cache file next to
  // configPath (tokenCache.ts) -- clean it up so one test's write can't
  // leak into another, or into a real run of this fixtures directory.
  afterEach(async () => {
    await rm(tokenCachePath(join(import.meta.dir, "fixtures", "bot.toml")), { force: true });
  });

  test("sends an auth request built from config, and stores you/token on success", async () => {
    const config = makeConfig();
    config.auth = { scheme: "token", token: "bootstrap-token" };
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    const authenticating = bot.authenticate();
    await waitForSentFrame(socket, previousCount);

    const sentFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };
    expect(sentFrame.method).toBe("auth");
    expect(sentFrame.params).toEqual({
      scheme: "token",
      token: "bootstrap-token",
      name: "cassie-test",
      agent: "cassie-bot/0.1",
    });

    socket.emitMessage(
      JSON.stringify({
        id: sentFrame.id,
        result: { you: { user_id: "cassie-test", name: "Cassie" }, token: "rotated-token" },
      }),
    );

    const result = await authenticating;
    expect(result.you).toEqual({ userId: "cassie-test", name: "Cassie" });
    expect(result.token).toBe("rotated-token");
    expect(bot.you).toEqual({ userId: "cassie-test", name: "Cassie" });
    expect(bot.token).toBe("rotated-token");

    // The rotated token should also have been persisted to the cache
    // file, keyed by this bot's serverUri (Apron §3.2.1).
    const cached = JSON.parse(
      await readFile(tokenCachePath(config.configPath), "utf-8"),
    );
    expect(cached[config.serverUri]).toBe("rotated-token");
  });

  test("prefers a cached token over config.auth.token's bootstrap value", async () => {
    const config = makeConfig();
    config.auth = { scheme: "token", token: "bootstrap-token" };

    // Simulate a previous run having already saved a rotated token.
    const { saveToken } = await import("../src/tokenCache");
    await saveToken(config.configPath, config.serverUri, "cached-token");

    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    bot.authenticate();
    await waitForSentFrame(socket, previousCount);

    const sentFrame = socket.lastSentFrame() as { params: { token?: string } };
    expect(sentFrame.params.token).toBe("cached-token");
  });

  test("wraps a denied (-32001) reply in an AuthDeniedError, preserving the original as .cause", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    const authenticating = bot.authenticate();
    await waitForSentFrame(socket, previousCount);
    const sentFrame = socket.lastSentFrame() as { id: string };

    socket.emitMessage(
      JSON.stringify({
        id: sentFrame.id,
        error: { code: -32001, message: "Session expired; sign in again" },
      }),
    );

    await expect(authenticating).rejects.toBeInstanceOf(AuthDeniedError);
    await expect(authenticating).rejects.toMatchObject({
      scheme: "guest",
      message: expect.stringContaining("Session expired; sign in again"),
      cause: expect.objectContaining({
        code: -32001,
        message: "Session expired; sign in again",
      }),
    });
  });

  test("propagates a non-denied ApronError as-is, without wrapping it", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    const authenticating = bot.authenticate();
    await waitForSentFrame(socket, previousCount);
    const sentFrame = socket.lastSentFrame() as { id: string };

    socket.emitMessage(
      JSON.stringify({
        id: sentFrame.id,
        error: { code: -32002, message: "Slow down", data: { retry_after: 5 } },
      }),
    );

    await expect(authenticating).rejects.toBeInstanceOf(ApronError);
    await expect(authenticating).rejects.toMatchObject({
      code: -32002,
      message: "Slow down",
    });
  });

  test("rejects with UnsupportedSchemeError before sending anything, if the server didn't advertise the scheme", async () => {
    const config = makeConfig();
    config.auth = { scheme: "webauthn" };
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    await expect(bot.authenticate()).rejects.toBeInstanceOf(UnsupportedSchemeError);
    await expect(bot.authenticate()).rejects.toMatchObject({
      scheme: "webauthn",
      offered: ["guest", "token"],
    });

    // No auth frame should have been sent -- the check runs before
    // _sendRequest.
    expect(socket.sent.length).toBe(previousCount);
  });
});

describe("Bot.ping", () => {
  test("sends exactly {method: 'ping'} with no id", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.ping();

    expect(socket.lastSentFrame()).toEqual({ method: "ping" });
  });
});

describe("Bot.sendMessage", () => {
  test("sends a message request and resolves with the server-assigned message_id", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const sending = bot.sendMessage("hello world", { roomId: "general" });
    const sentFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };

    expect(sentFrame.method).toBe("message");
    expect(sentFrame.params).toEqual({
      room_id: "general",
      body: { text: "hello world", format: "plain", mentions: [] },
    });

    socket.emitMessage(JSON.stringify({ id: sentFrame.id, result: { message_id: "123" } }));

    expect(await sending).toBe("123");
  });

  test("omits room_id when not given, posting to the default room", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    void bot.sendMessage("hi");
    const sentFrame = socket.lastSentFrame() as { params: Record<string, unknown> };

    expect(sentFrame.params).not.toHaveProperty("room_id");
  });
});

describe("Bot.getRoomList", () => {
  test("sends room_list with filter 'all' and resolves with the camelCased result", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const listing = bot.getRoomList();
    const sentFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };

    expect(sentFrame.method).toBe("room_list");
    expect(sentFrame.params).toEqual({ filter: "all" });

    socket.emitMessage(
      JSON.stringify({
        id: sentFrame.id,
        result: {
          joined: [{ room_id: "general", title: "General" }],
          not_joined: [{ room_id: "1724803312001", title: "Test Kitchen" }],
        },
      }),
    );

    expect(await listing).toEqual({
      joined: [{ roomId: "general", title: "General" }],
      notJoined: [{ roomId: "1724803312001", title: "Test Kitchen" }],
    });
  });

  test("rejects if called before connect() resolved", () => {
    const bot = new Bot(makeConfig());

    expect(() => bot.getRoomList()).toThrow();
  });
});

describe("Bot.joinRoom", () => {
  test("sends room_join with the given room_id and resolves on an empty result", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const joining = bot.joinRoom("1724803312001");
    const sentFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };

    expect(sentFrame.method).toBe("room_join");
    expect(sentFrame.params).toEqual({ room_id: "1724803312001" });

    socket.emitMessage(JSON.stringify({ id: sentFrame.id, result: {} }));

    await expect(joining).resolves.toBeUndefined();
  });
});

describe("Bot.leaveRoom", () => {
  test("sends room_leave (not room_join) with the given room_id and resolves on an empty result", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    const leaving = bot.leaveRoom("1724803312001");
    const sentFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };

    expect(sentFrame.method).toBe("room_leave");
    expect(sentFrame.params).toEqual({ room_id: "1724803312001" });

    socket.emitMessage(JSON.stringify({ id: sentFrame.id, result: {} }));

    await expect(leaving).resolves.toBeUndefined();
  });
});

describe("Bot.postConnect", () => {
  // The server frame used by this block's tests, advertising capability
  // "rooms" (Apron §4.2) so postConnect doesn't short-circuit on that
  // check. Tests that need to exercise the no-capability path build their
  // own greeting instead.
  const ROOMS_GREETING = JSON.stringify({
    method: "server",
    params: { apron: 10, auth: ["guest", "token"], capabilities: ["rooms"] },
  });

  test("does nothing, and sends no frames, when config.rooms is empty", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const previousCount = socket.sent.length;
    await bot.postConnect();

    expect(socket.sent.length).toBe(previousCount);
  });

  test("warns and skips listing entirely when the server has no 'rooms' capability", async () => {
    const config = makeConfig();
    config.rooms = ["general"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING); // no capabilities advertised
    await connecting;

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const previousCount = socket.sent.length;
    await bot.postConnect();

    expect(socket.sent.length).toBe(previousCount);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("general"));
    warnSpy.mockRestore();
  });

  test("resolves a configured name to a room_id by title, case-insensitively, and joins it", async () => {
    const config = makeConfig();
    config.rooms = ["Test Kitchen"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const postConnecting = bot.postConnect();
    await waitForSentFrame(socket);
    const listFrame = socket.lastSentFrame() as { method: string; id: string };
    expect(listFrame.method).toBe("room_list");

    const previousCount = socket.sent.length;
    socket.emitMessage(
      JSON.stringify({
        id: listFrame.id,
        result: { not_joined: [{ room_id: "1724803312001", title: "test kitchen" }] },
      }),
    );

    await waitForSentFrame(socket, previousCount);
    const joinFrame = socket.lastSentFrame() as { method: string; id: string; params: unknown };
    expect(joinFrame.method).toBe("room_join");
    expect(joinFrame.params).toEqual({ room_id: "1724803312001" });

    socket.emitMessage(JSON.stringify({ id: joinFrame.id, result: {} }));
    await postConnecting;
  });

  test("falls back to matching room_id directly when a room has no title", async () => {
    const config = makeConfig();
    config.rooms = ["general"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const postConnecting = bot.postConnect();
    await waitForSentFrame(socket);
    const listFrame = socket.lastSentFrame() as { id: string };

    const previousCount = socket.sent.length;
    socket.emitMessage(
      JSON.stringify({ id: listFrame.id, result: { not_joined: [{ room_id: "general" }] } }),
    );

    await waitForSentFrame(socket, previousCount);
    const joinFrame = socket.lastSentFrame() as { method: string; params: unknown };
    expect(joinFrame.method).toBe("room_join");
    expect(joinFrame.params).toEqual({ room_id: "general" });

    socket.emitMessage(JSON.stringify({ id: (socket.lastSentFrame() as { id: string }).id, result: {} }));
    await postConnecting;
  });

  test("skips a room that is already joined, without sending room_join", async () => {
    const config = makeConfig();
    config.rooms = ["general"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const postConnecting = bot.postConnect();
    await waitForSentFrame(socket);
    const listFrame = socket.lastSentFrame() as { id: string };

    const previousCount = socket.sent.length;
    socket.emitMessage(
      JSON.stringify({
        id: listFrame.id,
        result: { joined: [{ room_id: "general", title: "General" }] },
      }),
    );
    await postConnecting;

    expect(socket.sent.length).toBe(previousCount);
  });

  test("throws RoomNotFoundError, listing available rooms, when a configured name matches nothing", async () => {
    const config = makeConfig();
    config.rooms = ["nonexistent"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const postConnecting = bot.postConnect();
    await waitForSentFrame(socket);
    const listFrame = socket.lastSentFrame() as { id: string };

    socket.emitMessage(
      JSON.stringify({
        id: listFrame.id,
        result: {
          joined: [],
          not_joined: [
            { room_id: "general", title: "\ud83d\udc4b General" },
            { room_id: "1793310132874", title: "\ud83d\udea7 Test Kitchen" },
          ],
        },
      }),
    );

    await expect(postConnecting).rejects.toBeInstanceOf(RoomNotFoundError);
    await expect(postConnecting).rejects.toMatchObject({
      roomName: "nonexistent",
      available: [
        { roomId: "general", title: "\ud83d\udc4b General" },
        { roomId: "1793310132874", title: "\ud83d\udea7 Test Kitchen" },
      ],
      message: expect.stringContaining("\ud83d\udea7 Test Kitchen"),
    });
  });

  test("RoomNotFoundError's message lists '(none)' when the server has no rooms at all", async () => {
    const config = makeConfig();
    config.rooms = ["anything"];
    const bot = new Bot(config);
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(ROOMS_GREETING);
    await connecting;

    const postConnecting = bot.postConnect();
    await waitForSentFrame(socket);
    const listFrame = socket.lastSentFrame() as { id: string };

    socket.emitMessage(JSON.stringify({ id: listFrame.id, result: { joined: [], not_joined: [] } }));

    await expect(postConnecting).rejects.toMatchObject({ message: expect.stringContaining("(none)") });
  });
});

describe("Bot - 'user' notification handling (own identity, Apron §3.3.3)", () => {
  test("a 'you' notification updates bot.you's name", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot" };

    socket.emitMessage(
      JSON.stringify({ method: "user", params: { you: { user_id: "cassie", name: "Bot of toastdriven" } } }),
    );

    expect(bot.you).toEqual({ userId: "cassie", name: "Bot of toastdriven" });
  });

  test("a field the notification omits is left unchanged", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot", roles: ["bot"] };

    // Notification carries only a name change; roles is absent, not "".
    socket.emitMessage(
      JSON.stringify({ method: "user", params: { you: { user_id: "cassie", name: "Bot of toastdriven" } } }),
    );

    expect(bot.you).toEqual({ userId: "cassie", name: "Bot of toastdriven", roles: ["bot"] });
  });

  test("an empty string clears name, falling back to userId", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot" };

    socket.emitMessage(JSON.stringify({ method: "user", params: { you: { user_id: "cassie", name: "" } } }));

    expect(bot.you).toEqual({ userId: "cassie", name: undefined });
  });

  test("an empty roles array clears roles", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot", roles: ["bot"] };

    socket.emitMessage(JSON.stringify({ method: "user", params: { you: { user_id: "cassie", roles: [] } } }));

    expect(bot.you).toEqual({ userId: "cassie", name: "cassie-bot", roles: undefined });
  });

  test("a non-empty roles array replaces the kept roles", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot" };

    socket.emitMessage(
      JSON.stringify({ method: "user", params: { you: { user_id: "cassie", roles: ["bot", "trusted"] } } }),
    );

    expect(bot.you).toEqual({ userId: "cassie", name: "cassie-bot", roles: ["bot", "trusted"] });
  });

  test("ignores 'new'/'old' (other users) without touching bot.you", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.you = { userId: "cassie", name: "cassie-bot" };

    socket.emitMessage(
      JSON.stringify({ method: "user", params: { new: { user_id: "alice", name: "Alice L" } } }),
    );

    expect(bot.you).toEqual({ userId: "cassie", name: "cassie-bot" });
  });

  test("sets bot.you from a 'you' notification even if nothing was tracked yet", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    expect(bot.you).toBeUndefined();

    socket.emitMessage(
      JSON.stringify({ method: "user", params: { you: { user_id: "cassie", name: "Bot of toastdriven" } } }),
    );

    expect(bot.you).toEqual({ userId: "cassie", name: "Bot of toastdriven" });
  });
});

describe("Bot.receiveMessage", () => {
  test("logs and ignores a reply whose id matches no pending request", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitMessage(SERVER_GREETING);
    await connecting;

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    bot.receiveMessage(JSON.stringify({ id: "unknown-id", result: {} }));

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test("ignores an unknown method", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    FakeWebSocket.instances[0]!.emitMessage(SERVER_GREETING);
    await connecting;

    // Should not throw.
    expect(() => bot.receiveMessage(JSON.stringify({ method: "some_future_method" }))).not.toThrow();
  });

  test("a later server frame replaces serverInfo but does not resolve connect() again", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    socket.emitMessage(
      JSON.stringify({ method: "server", params: { apron: 10, auth: ["guest", "token"] } }),
    );

    expect(bot.serverInfo).toEqual({ apron: 10, auth: ["guest", "token"] });
  });

  test("a message notification builds an IMessageContext and runs it through onMessage", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    let seenText: string | undefined;
    bot.registerListener("capture", undefined, (ctx) => {
      seenText = ctx.message.text;
    });

    socket.emitMessage(
      JSON.stringify({
        method: "message",
        params: {
          room_id: "general",
          from: { user_id: "alice", name: "Alice" },
          body: { text: "hello", format: "plain", mentions: [] },
        },
      }),
    );

    // onMessage is fired-and-forgotten from receiveMessage; let the
    // microtask queue drain before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(seenText).toBe("hello");
  });

  test("a message notification with no body (a tombstone) is skipped", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    let called = false;
    bot.registerListener("capture", undefined, () => {
      called = true;
    });

    socket.emitMessage(
      JSON.stringify({
        method: "message",
        params: { room_id: "general", from: { user_id: "alice" }, deleted: true },
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(called).toBe(false);
  });

  test("ctx.reply() sends a message back to the room the incoming message arrived in", async () => {
    const bot = new Bot(makeConfig());
    const connecting = bot.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage(SERVER_GREETING);
    await connecting;

    bot.registerCommand("echo", undefined, async (ctx) => {
      await ctx.reply("echo: " + ctx.message.text);
      return true;
    });

    socket.emitMessage(
      JSON.stringify({
        method: "message",
        params: {
          room_id: "general",
          from: { user_id: "alice" },
          body: { text: "hi", format: "plain", mentions: [] },
        },
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    const replyFrame = socket.lastSentFrame() as { method: string; params: unknown };
    expect(replyFrame.method).toBe("message");
    expect(replyFrame.params).toEqual({
      room_id: "general",
      body: { text: "echo: hi", format: "plain", mentions: [] },
    });
  });
});
