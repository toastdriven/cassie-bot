// Thrown when a request frame's reply carries an `error` (Apron §1.1):
// `{"id": "...", "error": {"code": -32001, "message": "...", "data": {...}}}`.
// `code` is one of the JSON-RPC-shaped codes in the error table (§1.1) --
// callers should branch on `code`, not `message` (the spec says `message`
// is free text for people, not something to parse).
export class ApronError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApronError";
    this.code = code;
    this.data = data;
  }
}

// Thrown by Bot.authenticate() before it even sends `auth`, when
// config.auth.scheme isn't one the server advertised in its `server`
// greeting (Apron §3.2: "a scheme that the server does not offer is
// unsupported"). Catching this client-side, instead of letting the round
// trip come back as a bare ApronError(-32601), means the message can name
// both the requested scheme and what the server actually offers.
export class UnsupportedSchemeError extends Error {
  scheme: string;
  offered: string[];

  constructor(scheme: string, offered: string[]) {
    super(`Server does not offer auth scheme "${scheme}" (offers: ${offered.join(", ") || "none"})`);
    this.name = "UnsupportedSchemeError";
    this.scheme = scheme;
    this.offered = offered;
  }
}

// Thrown by Bot.postConnect() when a room named in config.rooms can't be
// resolved against the server's room_list (Apron §4.2.1) -- no room record
// whose title or room_id matches. Most often this means the configured
// name doesn't account for decoration a title actually carries (e.g. an
// emoji prefix the web UI shows but a plain-text config can't easily
// type), or a plain typo/casing mismatch the operator didn't catch.
// Carries every available title/room_id pair so the error message (and
// anything that catches this) can show the operator exactly what the
// server calls its rooms, instead of them guessing at exact text.
export class RoomNotFoundError extends Error {
  roomName: string;
  available: { roomId: string; title?: string }[];

  constructor(roomName: string, available: { roomId: string; title?: string }[]) {
    const listing = available.length
      ? available.map((room) => `  - ${room.title ?? room.roomId} (room_id: ${room.roomId})`).join("\n")
      : "  (none)";
    super(
      `Configured room "${roomName}" was not found on the server. Available rooms:\n${listing}`,
    );
    this.name = "RoomNotFoundError";
    this.roomName = roomName;
    this.available = available;
  }
}

// Thrown by Bot.authenticate() when the server's `auth` reply is a
// `denied` ApronError (code -32001, Apron §1.1's error table) -- the
// scheme itself was valid, but the credentials weren't accepted (bad/
// expired/revoked token, wrong invite code, etc). Wraps the original
// ApronError as `cause` so nothing is lost, but gives callers a message
// that names the scheme without needing to decode -32001 themselves.
export class AuthDeniedError extends Error {
  scheme: string;

  constructor(scheme: string, cause: ApronError) {
    super(`Authentication denied by server: ${cause.message} (scheme "${scheme}")`, { cause });
    this.name = "AuthDeniedError";
    this.scheme = scheme;
  }
}
