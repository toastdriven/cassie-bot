import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_CACHE_FILENAME,
  loadToken,
  saveToken,
  tokenCachePath,
} from "../src/tokenCache";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cassie-bot-token-cache-"));
  configPath = join(dir, "bot.toml");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tokenCachePath", () => {
  test("resolves to the cache filename next to the config file", () => {
    expect(tokenCachePath(configPath)).toBe(join(dir, TOKEN_CACHE_FILENAME));
  });
});

describe("loadToken", () => {
  test("returns undefined when there's no cache file yet", async () => {
    expect(await loadToken(configPath, "wss://example.test/ws")).toBeUndefined();
  });

  test("returns undefined when the cache file has no entry for this server", async () => {
    await saveToken(configPath, "wss://other.test/ws", "other-token");
    expect(await loadToken(configPath, "wss://example.test/ws")).toBeUndefined();
  });

  test("returns the saved token for this exact serverUri", async () => {
    await saveToken(configPath, "wss://example.test/ws", "saved-token");
    expect(await loadToken(configPath, "wss://example.test/ws")).toBe("saved-token");
  });

  test("returns undefined if the cache file isn't valid JSON", async () => {
    await writeFile(tokenCachePath(configPath), "not json at all", "utf-8");
    expect(await loadToken(configPath, "wss://example.test/ws")).toBeUndefined();
  });

  test("returns undefined if the cache file is a JSON value that isn't an object", async () => {
    await writeFile(tokenCachePath(configPath), JSON.stringify(["nope"]) , "utf-8");
    expect(await loadToken(configPath, "wss://example.test/ws")).toBeUndefined();
  });

  test("returns undefined if the matching entry isn't a string", async () => {
    await writeFile(
      tokenCachePath(configPath),
      JSON.stringify({ "wss://example.test/ws": 12345 }),
      "utf-8",
    );
    expect(await loadToken(configPath, "wss://example.test/ws")).toBeUndefined();
  });
});

describe("saveToken", () => {
  test("creates the cache file if it doesn't exist", async () => {
    await saveToken(configPath, "wss://example.test/ws", "fresh-token");

    const raw = await readFile(tokenCachePath(configPath), "utf-8");
    expect(JSON.parse(raw)).toEqual({ "wss://example.test/ws": "fresh-token" });
  });

  test("overwrites only the entry for the given serverUri, preserving others", async () => {
    await saveToken(configPath, "wss://example.test/ws", "first-token");
    await saveToken(configPath, "wss://other.test/ws", "other-token");
    await saveToken(configPath, "wss://example.test/ws", "rotated-token");

    const raw = await readFile(tokenCachePath(configPath), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      "wss://example.test/ws": "rotated-token",
      "wss://other.test/ws": "other-token",
    });
  });

  test("starts fresh if the existing cache file is corrupt, rather than failing", async () => {
    await writeFile(tokenCachePath(configPath), "{ not valid json", "utf-8");

    await saveToken(configPath, "wss://example.test/ws", "new-token");

    const raw = await readFile(tokenCachePath(configPath), "utf-8");
    expect(JSON.parse(raw)).toEqual({ "wss://example.test/ws": "new-token" });
  });

  test("round-trips through loadToken", async () => {
    await saveToken(configPath, "wss://example.test/ws", "round-trip-token");
    expect(await loadToken(configPath, "wss://example.test/ws")).toBe("round-trip-token");
  });
});
