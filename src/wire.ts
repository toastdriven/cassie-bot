// Thin, partial types for the handful of Apron wire shapes Bot needs to
// read/build directly (not the full protocol -- see IChatMessage in
// interfaces.ts for the shape handlers actually see). These are deliberately
// loose (optional, not exhaustive): we only model what we read or send today,
// per Apron §3.1 (server frame), §3.2 (auth), §3.3 (identity), §3.5
// (messages). Field names here are already camelCase; the snake_case <->
// camelCase conversion happens once, at receiveMessage/send, via
// src/utils.ts.

// Apron §3.1 `server` frame. Sent by the server immediately on connect, and
// again any time its capabilities change (e.g. after sign-in).
export interface IServerInfo {
  apron: number;
  auth: string[];
  agent?: string;
  capabilities?: string[];
  welcome?: string;
  signup?: string[];
  ping?: number; // seconds between client pings (§1)
  title?: string;
  description?: string;
}

// Apron §3.3 `User` (partial -- only the fields Bot keeps track of today).
export interface IUser {
  userId: string;
  name?: string;
  roles?: string[];
}

// Apron §3.2 `AuthResult`.
export interface IAuthResult {
  you?: IUser;
  token?: string;
}
