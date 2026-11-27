// Metadata about a registered handler, separate from the handler function
// itself. Starts with just `description` (e.g. for a /help responder to
// list available commands/responders); expected to grow as new needs come
// up (usage strings, aliases, ...).
export interface IHandlerOptions {
  description?: string;
}

export interface IRegistry<T> {
  register(name: string, options: IHandlerOptions | undefined, func: T): void;
  unregister(name: string): T | undefined;
  describe(name: string): IHandlerOptions | undefined;
}

// One entry in Bot.listHandlers()'s consolidated listing -- which registry
// a handler is in, plus its name and options. Lets something like /help
// describe every registered handler without reaching into Bot's internal
// registry fields directly.
export interface IHandlerDescription extends IHandlerOptions {
  kind: "listener" | "command" | "responder";
  name: string;
}

// A single chat message, camelCased for internal use. This mirrors the wire
// `Message` shape from Apron §3.5, but is not it -- the wire format uses
// snake_case (`room_id`, `user_id`, ...) and nested nullable fields that
// exist for protocol reasons (e.g. absent `body` on a tombstone). Conversion
// between the two happens at the boundary: when a frame first arrives off
// the websocket, and again just before a frame is sent. Internal code,
// including every Handler, only ever sees this shape.
//
// TODO: not yet modeled, out of scope until needed --
//   - message_id / log_id / prev_log_id (useful once "edit"/"history" land)
//   - reply_to (threading)
//   - embeds (capability "embeds", §4.8)
//   - roles on `from` (§3.3.4)
export interface IChatMessage {
  text: string;
  format: "plain" | "markdown";
  from: {
    userId: string;
    name?: string;
  };
  roomId?: string;           // undefined: the server's default room
  mentions: string[];        // user_ids
}

// What a Handler (listener/command/responder) receives for each incoming
// message: the message itself, plus the ability to act on it without
// knowing anything about the underlying transport.
export interface IMessageContext {
  readonly message: IChatMessage;

  // Sends a new message back to the same room the incoming message arrived
  // in. Internal callers pass camelCase options here too; whatever
  // implements this interface is responsible for converting to the wire
  // (snake_case) `message` request before sending.
  //
  // TODO: stubbed at the interface level only -- there is no websocket
  // client yet to actually implement this against. Revisit the signature
  // once that exists (e.g. does it need to report the server's assigned
  // message_id back to the caller?).
  reply(text: string, options?: { format?: "plain" | "markdown" }): Promise<void>;
}
