import { describe, expect, test } from "bun:test";
import {
  camelToSnake,
  camelToSnakeKey,
  isPlainObject,
  snakeToCamel,
  snakeToCamelKey,
} from "../src/utils";

describe("isPlainObject", () => {
  test("true for a plain object literal", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test("true for an empty object", () => {
    expect(isPlainObject({})).toBe(true);
  });

  test("false for an array", () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  test("false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  test("false for primitives", () => {
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("snakeToCamelKey", () => {
  test("converts a single underscore boundary", () => {
    expect(snakeToCamelKey("room_id")).toBe("roomId");
  });

  test("converts multiple underscore boundaries", () => {
    expect(snakeToCamelKey("prev_room_id")).toBe("prevRoomId");
  });

  test("leaves a key with no underscores unchanged", () => {
    expect(snakeToCamelKey("text")).toBe("text");
  });

  test("converts a boundary before a digit", () => {
    expect(snakeToCamelKey("foo_2bar")).toBe("foo2bar");
  });
});

describe("camelToSnakeKey", () => {
  test("converts a single capital letter", () => {
    expect(camelToSnakeKey("roomId")).toBe("room_id");
  });

  test("converts multiple capital letters", () => {
    expect(camelToSnakeKey("prevRoomId")).toBe("prev_room_id");
  });

  test("leaves a key with no capitals unchanged", () => {
    expect(camelToSnakeKey("text")).toBe("text");
  });
});

describe("snakeToCamel", () => {
  test("converts keys of a flat object", () => {
    expect(snakeToCamel({ room_id: "general", log_id: "123" })).toEqual({
      roomId: "general",
      logId: "123",
    });
  });

  test("recurses into nested objects", () => {
    expect(
      snakeToCamel({
        body: { text: "hi", prev_log_id: "1" },
        from: { user_id: "alice" },
      }),
    ).toEqual({
      body: { text: "hi", prevLogId: "1" },
      from: { userId: "alice" },
    });
  });

  test("recurses into arrays of objects", () => {
    expect(snakeToCamel([{ user_id: "a" }, { user_id: "b" }])).toEqual([
      { userId: "a" },
      { userId: "b" },
    ]);
  });

  test("leaves arrays of primitives unchanged", () => {
    expect(snakeToCamel({ mentions: ["alice", "bob"] })).toEqual({
      mentions: ["alice", "bob"],
    });
  });

  test("passes through primitives and null unchanged", () => {
    expect(snakeToCamel("plain_text")).toBe("plain_text");
    expect(snakeToCamel(42)).toBe(42);
    expect(snakeToCamel(null)).toBe(null);
    expect(snakeToCamel(true)).toBe(true);
  });
});

describe("camelToSnake", () => {
  test("converts keys of a flat object", () => {
    expect(camelToSnake({ roomId: "general", logId: "123" })).toEqual({
      room_id: "general",
      log_id: "123",
    });
  });

  test("recurses into nested objects", () => {
    expect(
      camelToSnake({
        body: { text: "hi", prevLogId: "1" },
        from: { userId: "alice" },
      }),
    ).toEqual({
      body: { text: "hi", prev_log_id: "1" },
      from: { user_id: "alice" },
    });
  });

  test("recurses into arrays of objects", () => {
    expect(camelToSnake([{ userId: "a" }, { userId: "b" }])).toEqual([
      { user_id: "a" },
      { user_id: "b" },
    ]);
  });

  test("leaves arrays of primitives unchanged", () => {
    expect(camelToSnake({ mentions: ["alice", "bob"] })).toEqual({
      mentions: ["alice", "bob"],
    });
  });

  test("passes through primitives and null unchanged", () => {
    expect(camelToSnake("plainText")).toBe("plainText");
    expect(camelToSnake(42)).toBe(42);
    expect(camelToSnake(null)).toBe(null);
    expect(camelToSnake(true)).toBe(true);
  });
});

describe("snakeToCamel / camelToSnake round-trip", () => {
  test("a wire-shaped message round-trips through both conversions", () => {
    const wire = {
      room_id: "general",
      message_id: "1724803200042",
      log_id: "1724803200042",
      from: { user_id: "alice", name: "Alice" },
      body: { text: "hello", format: "markdown", mentions: ["bob"] },
    };

    expect(camelToSnake(snakeToCamel(wire))).toEqual(wire);
  });
});
