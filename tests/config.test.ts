import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Config } from "../src/config";

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

describe("Config", () => {
  test("constructor sets configPath and leaves the rest at their defaults", () => {
    const config = new Config("./some/path.toml");

    expect(config.configPath).toBe("./some/path.toml");
    expect(config.botName).toBe("cassie-bot");
    expect(config.serverUri).toBe("");
    expect(config.agent).toBe("cassie-bot/0.1");
    expect(config.auth).toEqual({ scheme: "guest" });
    expect(config.rooms).toEqual([]);
    expect(config.handlers).toEqual([]);
    expect(config.disabled).toEqual([]);
  });

  test("loadFromFile returns a Config, not a mutated instance", async () => {
    const config = await Config.loadFromFile(fixture("minimal.toml"));
    expect(config).toBeInstanceOf(Config);
  });

  test("loadFromFile parses a fully-populated TOML file", async () => {
    const path = fixture("full.toml");
    const config = await Config.loadFromFile(path);

    expect(config.configPath).toBe(path);
    expect(config.botName).toBe("cassie");
    expect(config.serverUri).toBe("wss://chat.example/ws");
    expect(config.agent).toBe("cassie-bot/0.1");
    expect(config.auth).toEqual({ scheme: "token", token: "secret-token" });
    expect(config.rooms).toEqual(["general", "ops"]);
    expect(config.handlers).toEqual(["metar", "giphy"]);
    expect(config.disabled).toEqual(["help"]);
  });

  test("loadFromFile falls back to defaults for fields the file omits", async () => {
    const config = await Config.loadFromFile(fixture("minimal.toml"));

    // Present in the file:
    expect(config.serverUri).toBe("ws://localhost:8080/ws");
    expect(config.auth).toEqual({ scheme: "guest" });

    // Omitted, so defaults should stand:
    expect(config.botName).toBe("cassie-bot");
    expect(config.agent).toBe("cassie-bot/0.1");
    expect(config.rooms).toEqual([]);
    expect(config.handlers).toEqual([]);
    expect(config.disabled).toEqual([]);
  });

  test("loadFromFile ignores fields of the wrong type instead of throwing", async () => {
    const config = await Config.loadFromFile(fixture("invalid-types.toml"));

    // Every field in the fixture has the wrong type, so every field should
    // have been left at its default rather than parsed in.
    expect(config.botName).toBe("cassie-bot");
    expect(config.rooms).toEqual([]);
    expect(config.handlers).toEqual([]);
    expect(config.auth).toEqual({ scheme: "guest" });
  });

  test("loadFromFile rejects when the file does not exist", async () => {
    await expect(Config.loadFromFile(fixture("does-not-exist.toml"))).rejects.toThrow();
  });
});
