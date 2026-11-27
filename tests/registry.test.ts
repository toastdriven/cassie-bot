import { describe, expect, test } from "bun:test";
import { Registry } from "../src/registry";

// Registry<T> doesn't care what T is -- tests use plain functions as
// stand-ins for real Handler types.
type Fn = (...args: unknown[]) => unknown;

describe("Registry", () => {
  test("register then unregister returns the same function", () => {
    const registry = new Registry<Fn>();
    const handler: Fn = () => "hello";

    registry.register("greet", undefined, handler);

    expect(registry.unregister("greet")).toBe(handler);
  });

  test("unregister removes the entry, so a second unregister returns undefined", () => {
    const registry = new Registry<Fn>();
    registry.register("greet", undefined, () => "hello");

    registry.unregister("greet");

    expect(registry.unregister("greet")).toBeUndefined();
  });

  test("unregister on a name that was never registered returns undefined", () => {
    const registry = new Registry<Fn>();

    expect(registry.unregister("never-registered")).toBeUndefined();
  });

  test("registering a duplicate name throws", () => {
    const registry = new Registry<Fn>();
    registry.register("greet", undefined, () => "first");

    expect(() => registry.register("greet", undefined, () => "second")).toThrow();
  });

  test("a name can be re-registered after being unregistered", () => {
    const registry = new Registry<Fn>();
    const first: Fn = () => "first";
    const second: Fn = () => "second";

    registry.register("greet", undefined, first);
    registry.unregister("greet");
    registry.register("greet", undefined, second);

    expect(registry.unregister("greet")).toBe(second);
  });

  test("describe returns the options a handler was registered with", () => {
    const registry = new Registry<Fn>();
    registry.register("help", { description: "shows help" }, () => {});

    expect(registry.describe("help")).toEqual({ description: "shows help" });
  });

  test("describe defaults to an empty options object when none was given", () => {
    const registry = new Registry<Fn>();
    registry.register("quiet", undefined, () => {});

    expect(registry.describe("quiet")).toEqual({});
  });

  test("describe returns undefined for a name that isn't registered", () => {
    const registry = new Registry<Fn>();

    expect(registry.describe("missing")).toBeUndefined();
  });

  test("describe returns undefined after the handler is unregistered", () => {
    const registry = new Registry<Fn>();
    registry.register("help", { description: "shows help" }, () => {});
    registry.unregister("help");

    expect(registry.describe("help")).toBeUndefined();
  });

  test("iterating the registry directly yields [name, handler] pairs in registration order", () => {
    const registry = new Registry<Fn>();
    const first: Fn = () => "first";
    const second: Fn = () => "second";
    const third: Fn = () => "third";

    registry.register("c", undefined, third);
    registry.register("a", undefined, first);
    registry.register("b", undefined, second);

    expect([...registry]).toEqual([
      ["c", third],
      ["a", first],
      ["b", second],
    ]);
  });

  test("entries() yields the same [name, handler] pairs as direct iteration", () => {
    const registry = new Registry<Fn>();
    const handler: Fn = () => "hello";
    registry.register("greet", undefined, handler);

    expect([...registry.entries()]).toEqual([["greet", handler]]);
  });

  test("list() yields [name, options] pairs in registration order", () => {
    const registry = new Registry<Fn>();
    registry.register("b", { description: "second" }, () => {});
    registry.register("a", { description: "first" }, () => {});

    expect([...registry.list()]).toEqual([
      ["b", { description: "second" }],
      ["a", { description: "first" }],
    ]);
  });

  test("list() reflects an unregistered handler's absence", () => {
    const registry = new Registry<Fn>();
    registry.register("a", { description: "first" }, () => {});
    registry.register("b", { description: "second" }, () => {});
    registry.unregister("a");

    expect([...registry.list()]).toEqual([["b", { description: "second" }]]);
  });

  test("an empty registry iterates to nothing", () => {
    const registry = new Registry<Fn>();

    expect([...registry]).toEqual([]);
    expect([...registry.entries()]).toEqual([]);
    expect([...registry.list()]).toEqual([]);
  });
});
