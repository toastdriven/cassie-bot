import { Config } from './config';
import { Registry } from './registry';
import { ApronError, AuthDeniedError, UnsupportedSchemeError } from './errors';
import { camelToSnake, snakeToCamel } from './utils';
import { loadToken, saveToken } from './tokenCache';
import type {
  ListenerHandler,
  CommandHandler,
  ResponderHandler,
} from './types';
import type {
  IHandlerDescription,
  IHandlerOptions,
  IMessageContext,
  IChatMessage,
} from './interfaces';
import type { IAuthResult, IRoomListResult, IRoomRecord, IServerInfo, IUser } from './wire';

// A configured room name matches a room record by title (case-insensitive --
// titles are a free-form display string, Apron §4.2) or, failing that, by
// room_id directly (covers a server with no title set, where room_id doubles
// as the display name -- e.g. the spec's own "general" example).
function matchesRoomName(room: IRoomRecord, configuredName: string): boolean {
  const title = room.title ?? room.roomId;
  return title.toLowerCase() === configuredName.toLowerCase() || room.roomId === configuredName;
}

// Merges a `user` notification's `you` into the kept IUser, per Apron
// §3.3.1's "current object" rule: a field the notification doesn't carry
// stays as it was; a field it carries replaces the kept value; an empty
// value ("" or []) clears the field rather than being stored literally.
// `userId` is always present and always wins.
//
// `incoming` is deliberately typed loosely (not IUser) -- presence ("was
// this key sent at all?") matters here, which an optional TS field can't
// distinguish from "sent as undefined", so field checks below use `in`
// against the raw object instead of `!== undefined`.
function mergeUser(existing: IUser | undefined, incoming: Record<string, unknown>): IUser {
  const merged: IUser = { userId: incoming.userId as string, name: existing?.name, roles: existing?.roles };

  if ("name" in incoming) {
    merged.name = incoming.name === "" ? undefined : (incoming.name as string);
  }
  if ("roles" in incoming) {
    const roles = incoming.roles as string[];
    merged.roles = roles.length === 0 ? undefined : roles;
  }

  return merged;
}

// A frame off the wire, already passed through snakeToCamel -- see
// receiveMessage. Loose on purpose: every field below is actually optional
// depending on whether the frame is a notification, a request reply, or an
// out-of-band error (Apron §1.1).
interface IWireFrame {
  method?: string;
  id?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

export class Bot {
  config: Config;
  listenerRegistry: Registry<ListenerHandler>;
  commandRegistry: Registry<CommandHandler>;
  responderRegistry: Registry<ResponderHandler>;

  // Connection state. `undefined` until connect() succeeds.
  socket: WebSocket | undefined;
  serverInfo: IServerInfo | undefined;

  // Identity state. `undefined` until authenticate() succeeds.
  you: IUser | undefined;
  // The token actually used/saved by the most recent authenticate() --
  // see tokenCache.ts. Per Apron §3.2.1 the server may rotate this on any
  // auth reply; authenticate() persists a rotated token to the on-disk
  // cache (keyed by config.serverUri) so later runs pick it up instead of
  // falling back to the config file's bootstrap config.auth.token.
  token: string | undefined;

  _pendingRequests: Map<string, PendingRequest> = new Map();
  _pendingConnect: PendingRequest | undefined;
  _pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: Config) {
    this.config = config;
    this.listenerRegistry = new Registry<ListenerHandler>();
    this.commandRegistry = new Registry<CommandHandler>();
    this.responderRegistry = new Registry<ResponderHandler>();
  }

  registerListener(name: string, options: IHandlerOptions | undefined, func: ListenerHandler): void {
    this.listenerRegistry.register(name, options, func);
  }

  registerCommand(name: string, options: IHandlerOptions | undefined, func: CommandHandler): void {
    this.commandRegistry.register(name, options, func);
  }

  registerResponder(name: string, options: IHandlerOptions | undefined, func: ResponderHandler): void {
    this.responderRegistry.register(name, options, func);
  }

  // Every registered handler across all three registries, each tagged with
  // which kind it is. Lets a handler (e.g. /help) describe what's
  // registered without reaching into listenerRegistry/commandRegistry/
  // responderRegistry directly -- those fields are Bot's own internals,
  // not something handler authors should need to know about.
  listHandlers(): IHandlerDescription[] {
    const described: IHandlerDescription[] = [];

    for (const [name, options] of this.listenerRegistry.list()) {
      described.push({ kind: "listener", name, ...options });
    }
    for (const [name, options] of this.commandRegistry.list()) {
      described.push({ kind: "command", name, ...options });
    }
    for (const [name, options] of this.responderRegistry.list()) {
      described.push({ kind: "responder", name, ...options });
    }

    return described;
  }

  async onMessage(ctx: IMessageContext): Promise<void> {
    // Listeners always run, in full, regardless of outcome -- they're
    // side-effect only (e.g. logging) and never claim a message.
    for (const [, handler] of this.listenerRegistry) {
      await handler(ctx);
    }

    // Commands run next, in registration order, stopping at the first
    // handler that reports it handled the message.
    for (const [, handler] of this.commandRegistry) {
      if (await handler(ctx)) {
        return;
      }
    }

    // Responders are the fallback: only reached if no command claimed
    // the message. Same stop-on-first-match rule.
    for (const [, handler] of this.responderRegistry) {
      if (await handler(ctx)) {
        return;
      }
    }
  }

  // Opens the websocket to config.serverUri and resolves once the server's
  // greeting `server` frame arrives (Apron §3.1: the server sends this
  // immediately on accept, before the client sends anything). Does NOT
  // authenticate -- call authenticate() once this resolves.
  connect(): Promise<IServerInfo> {
    if (this.socket) {
      throw new Error("Bot is already connected (or connecting)");
    }

    return new Promise<IServerInfo>((resolve, reject) => {
      this._pendingConnect = { resolve: resolve as (result: unknown) => void, reject };

      const socket = new WebSocket(this.config.serverUri);
      this.socket = socket;

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          // Apron frames are whole JSON text messages (§1). Anything else
          // isn't a frame this client understands.
          return;
        }
        this.receiveMessage(event.data);
      };

      socket.onerror = () => {
        // The browser/undici WebSocket error event carries no useful detail
        // (no error object, no message); the close event that follows it
        // is where we actually learn anything. Nothing to do here but let
        // onclose handle cleanup/rejection.
      };

      socket.onclose = () => {
        this._handleClose();
      };
    });
  }

  // Closes the connection, if open. Stops the ping timer and fails any
  // requests still waiting on a reply -- they have no connection left to
  // reply on.
  disconnect(): void {
    this.socket?.close();
    this._handleClose();
  }

  _handleClose(): void {
    this._stopPing();

    const closedError = new Error("Bot disconnected before a reply arrived");
    for (const pending of this._pendingRequests.values()) {
      pending.reject(closedError);
    }
    this._pendingRequests.clear();

    if (this._pendingConnect) {
      this._pendingConnect.reject(new Error("Connection closed before the server frame arrived"));
      this._pendingConnect = undefined;
    }

    this.socket = undefined;
    this.serverInfo = undefined;
  }

  // Sends `auth` (Apron §3.2) using config.auth, and keeps `you`/`token` on
  // success. Call after connect() resolves.
  //
  // The token sent is whichever is freshest: a previously-saved, rotated
  // token for this exact serverUri (Apron §3.2.1's same-origin rule --
  // never send a token to a server other than the one that issued it)
  // takes priority over config.auth.token, which is only ever the
  // bootstrap value from the TOML file and goes stale after the first
  // rotation.
  //
  // Two failure modes get upgraded from bare ApronErrors into typed,
  // named errors (see errors.ts):
  // - UnsupportedSchemeError: config.auth.scheme isn't one the server's
  //   greeting advertised (§3.2) -- caught before sending anything, so
  //   there's no round trip just to learn this.
  // - AuthDeniedError: the scheme is valid, but the server's `auth` reply
  //   was a `denied` (-32001) ApronError -- bad/expired/revoked token,
  //   wrong invite code, etc. Only detectable after the round trip.
  async authenticate(): Promise<IAuthResult> {
    if (!this.serverInfo) {
      throw new Error("authenticate() called before connect() resolved");
    }

    const scheme = this.config.auth.scheme;
    if (!this.serverInfo.auth.includes(scheme)) {
      throw new UnsupportedSchemeError(scheme, this.serverInfo.auth);
    }

    const cachedToken = await loadToken(this.config.configPath, this.config.serverUri);
    const token = cachedToken ?? this.config.auth.token;

    let result: IAuthResult;
    try {
      result = await this._sendRequest<IAuthResult>("auth", {
        scheme,
        ...(token ? { token } : {}),
        name: this.config.botName,
        agent: this.config.agent,
      });
    } catch (err) {
      if (err instanceof ApronError && err.code === -32001) {
        throw new AuthDeniedError(scheme, err);
      }
      throw err;
    }

    if (result.you) {
      this.you = result.you;
    }
    if (result.token) {
      this.token = result.token;
      await saveToken(this.config.configPath, this.config.serverUri, result.token);
    }

    return result;
  }

  // Sends exactly `{"method": "ping"}`, per Apron §1. This is a
  // notification, not a request -- the server's `pong` is a notification
  // too, so there's nothing to await here. Clients only ever send this
  // direction; servers never ping clients.
  ping(): void {
    this._sendNotification("ping");
  }

  _startPing(intervalSeconds: number): void {
    this._stopPing();
    this._pingTimer = setInterval(() => this.ping(), intervalSeconds * 1000);
  }

  _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = undefined;
    }
  }

  // Joins every room named in config.rooms, resolving each configured name
  // against the server's room listing first -- room_id (Apron §2.1) is an
  // opaque, server-assigned identifier, never the display name a user
  // configures. "general" working by plain string match was a coincidence
  // of that particular server's example data (room_id happened to equal
  // its own title), not something a client can rely on in general.
  //
  // No-ops gracefully (with a warning) if the server lacks capability
  // "rooms" at all -- without it there is exactly one default room and no
  // room_join (Apron §3.4/§4.2).
  async postConnect(): Promise<void> {
    if (!this.serverInfo) {
      throw new Error("postConnect() called before connect() resolved");
    }

    if (!this.config.rooms.length) {
      return;
    }

    if (!this.serverInfo.capabilities?.includes("rooms")) {
      console.warn(
        `cassie-bot: config lists rooms (${this.config.rooms.join(", ")}) but the server has no "rooms" capability -- skipping`,
      );
      return;
    }

    const { joined = [], notJoined = [] } = await this.getRoomList();
    const known = [...joined, ...notJoined];

    for (const roomName of this.config.rooms) {
      const alreadyJoined = joined.some((room) => matchesRoomName(room, roomName));
      if (alreadyJoined) {
        continue;
      }

      const match = known.find((room) => matchesRoomName(room, roomName));
      if (!match) {
        console.warn(`cassie-bot: configured room "${roomName}" not found on server -- skipping`);
        continue;
      }

      await this.joinRoom(match.roomId);
    }
  }

  // Lists rooms visible to this connection (Apron §4.2.1). Returns the raw
  // joined/notJoined/left arrays of room records -- callers match against
  // config-provided display names themselves (see postConnect).
  async getRoomList(): Promise<IRoomListResult> {
    if (!this.serverInfo) {
      throw new Error("getRoomList() called before connect() resolved");
    }

    return this._sendRequest<IRoomListResult>("room_list", {
      filter: "all",
    });
  }

  // Joins a room by its server-assigned room_id (not a display name --
  // resolve a configured name to a room_id via getRoomList()/postConnect
  // first). Per Apron §4.2.2, the result is just "{}"; nothing meaningful
  // to return.
  async joinRoom(roomId: string): Promise<void> {
    await this._sendRequest<Record<string, never>>("room_join", { roomId });
  }

  // Leaves a room by its server-assigned room_id. Same "{}" result as
  // joinRoom (Apron §4.2.2).
  async leaveRoom(roomId: string): Promise<void> {
    await this._sendRequest<Record<string, never>>("room_leave", { roomId });
  }

  // The handler-facing API: posts a message (Apron §3.5) and resolves with
  // its permanent message_id once the server confirms it.
  async sendMessage(
    text: string,
    options?: { roomId?: string; format?: "plain" | "markdown"; mentions?: string[] },
  ): Promise<string> {
    const result = await this._sendRequest<{ messageId: string }>("message", {
      ...(options?.roomId ? { roomId: options.roomId } : {}),
      body: {
        text,
        format: options?.format ?? "plain",
        mentions: options?.mentions ?? [],
      },
    });

    return result.messageId;
  }

  // Sends a request frame (one with an `id`) and resolves/rejects when its
  // matched reply arrives -- see receiveMessage. `params` is camelCase;
  // converted to the wire's snake_case just before sending.
  _sendRequest<R>(method: string, params?: unknown): Promise<R> {
    if (!this.socket) {
      throw new Error("Bot is not connected");
    }

    const id = crypto.randomUUID();
    const frame: Record<string, unknown> = { method, id };
    if (params !== undefined) {
      frame.params = camelToSnake(params);
    }

    return new Promise<R>((resolve, reject) => {
      this._pendingRequests.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.socket!.send(JSON.stringify(frame));
    });
  }

  // Sends a notification frame (no `id`, no reply expected).
  _sendNotification(method: string, params?: unknown): void {
    if (!this.socket) {
      throw new Error("Bot is not connected");
    }

    const frame: Record<string, unknown> = { method };
    if (params !== undefined) {
      frame.params = camelToSnake(params);
    }

    this.socket.send(JSON.stringify(frame));
  }

  // Parses one incoming frame and dispatches it. Exposed (not private) so
  // it's straightforward to unit test without a real socket.
  receiveMessage(raw: string): void {
    const frame = snakeToCamel(JSON.parse(raw)) as IWireFrame;

    // A reply to one of our own requests, matched by id (Apron §1.1).
    if (frame.id !== undefined) {
      const pending = this._pendingRequests.get(frame.id);
      if (pending) {
        this._pendingRequests.delete(frame.id);
        if (frame.error) {
          pending.reject(new ApronError(frame.error.code, frame.error.message, frame.error.data));
        } else {
          pending.resolve(frame.result);
        }
        return;
      }
      // An id we don't recognize (e.g. a stale reply after disconnect, or
      // a server bug) -- nothing to match it to, so there's nothing to
      // *do* with it, but it's unusual enough to be worth a log line
      // rather than silently vanishing.
      if (!frame.method) {
        console.log(`cassie-bot: received a reply for unknown request id ${frame.id}`, frame);
        return;
      }
    }

    switch (frame.method) {
      case "server": {
        const info = frame.params as IServerInfo;
        const isGreeting = this.serverInfo === undefined;
        this.serverInfo = info;

        if (info.ping) {
          this._startPing(info.ping);
        } else {
          this._stopPing();
        }

        if (isGreeting && this._pendingConnect) {
          this._pendingConnect.resolve(info);
          this._pendingConnect = undefined;
        }
        return;
      }

      case "message": {
        void this._handleIncomingMessage(frame.params as Record<string, unknown>);
        return;
      }

      case "pong":
        // Liveness acknowledgement; nothing to do with it today.
        return;

      case "user": {
        // Only `you` is tracked -- the bot's own identity, so handlers can
        // match @mentions of its current name (Apron §3.3.3). `new`/`old`
        // describe *other* users sharing a room with the bot; out of scope
        // for now (no user directory kept).
        const params = frame.params as { you?: Record<string, unknown> } | undefined;
        if (params?.you) {
          this.you = mergeUser(this.you, params.you);
        }
        return;
      }

      default:
        // Unknown method, or no method at all (e.g. an out-of-band error
        // with no id, Apron §1.1). Receivers ignore both.
        return;
    }
  }

  async _handleIncomingMessage(params: Record<string, unknown>): Promise<void> {
    const body = params.body as
      | { text?: string; format?: "plain" | "markdown"; mentions?: string[] }
      | undefined;

    // TODO: a message notification with no `body` is a tombstone (a
    // delete, Apron §4.4 "edit" capability). Nothing consumes those yet;
    // skip rather than hand handlers a message with no text.
    if (!body) {
      return;
    }

    const from = params.from as { userId: string; name?: string };
    const roomId = params.roomId as string | undefined;

    const message: IChatMessage = {
      text: body.text ?? "",
      format: body.format ?? "plain",
      from: { userId: from.userId, ...(from.name ? { name: from.name } : {}) },
      ...(roomId ? { roomId } : {}),
      mentions: body.mentions ?? [],
    };

    const ctx: IMessageContext = {
      message,
      reply: async (text: string, options?: { format?: "plain" | "markdown" }) => {
        await this.sendMessage(text, { roomId, format: options?.format });
      },
    };

    await this.onMessage(ctx);
  }
}
