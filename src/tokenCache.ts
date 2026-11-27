import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Per Apron §3.2.1: a successful `auth` result MAY carry a rotated `token`;
// the client saves the latest one and reconnects with it next time. This
// is that save -- a small JSON file living next to the user's config file,
// keyed by serverUri so a single cache file still does the right thing if
// a bot ever talks to more than one server (or the config's serverUri
// changes across restarts): "clients send a token only to the server
// address that they got it from" (§1) means the token for server A must
// never leak into an auth request sent to server B.
//
// Deliberately NOT written into the TOML config file itself -- that file
// is user-authored (hand-edited, plausibly checked into version control),
// and a rotating bearer token is exactly the kind of secret that must
// never end up in git history alongside it. Keeping it in its own
// sibling file also means the config file's own formatting/comments are
// never at risk of being silently rewritten by the bot.
//
// File shape: { [serverUri: string]: string }.

// The cache file's name, not its full path -- callers resolve it relative
// to the directory containing the config file (see tokenCachePath below).
export const TOKEN_CACHE_FILENAME = ".cassie-bot-tokens.json";

export function tokenCachePath(configPath: string): string {
  return join(dirname(configPath), TOKEN_CACHE_FILENAME);
}

// Reads the token saved for serverUri, or undefined if there's no cache
// file yet, no entry for this server, or the file doesn't parse as the
// expected shape. Never throws -- a missing/corrupt cache is equivalent
// to "no saved token," not a fatal error; the bootstrap config.auth.token
// is the fallback either way.
export async function loadToken(configPath: string, serverUri: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(tokenCachePath(configPath), "utf-8");
  } catch {
    return undefined;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const token = (data as Record<string, unknown>)[serverUri];
  return typeof token === "string" ? token : undefined;
}

// Saves/replaces the token for serverUri, preserving whatever other
// servers' tokens are already in the cache file. Read-modify-write, not
// atomic -- fine for a single bot process's own cache file; not meant to
// be shared/written concurrently by multiple processes.
export async function saveToken(configPath: string, serverUri: string, token: string): Promise<void> {
  const path = tokenCachePath(configPath);

  let data: Record<string, string> = {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      data = parsed as Record<string, string>;
    }
  } catch {
    // No existing cache file, or it's corrupt -- start fresh rather than
    // failing to save a token we just successfully authenticated with.
  }

  data[serverUri] = token;
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}
