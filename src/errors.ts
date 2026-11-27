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
