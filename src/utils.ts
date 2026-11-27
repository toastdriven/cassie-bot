// Generic camelCase <-> snake_case conversion, used at the wire boundary
// (Apron frames are snake_case; everything internal is camelCase -- see
// IChatMessage/IMessageContext in interfaces.ts). Deliberately
// straightforward: no special-casing for acronyms, arrays of primitives,
// Dates, etc. If a field ever needs different treatment, handle it at the
// call site rather than teaching these functions a special case.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// "room_id" -> "roomId"
export function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

// "roomId" -> "room_id"
export function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// Recursively converts every object key from snake_case to camelCase.
// Arrays are walked (so each element is converted too); every other value
// (strings, numbers, booleans, null) is returned as-is.
export function snakeToCamel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => snakeToCamel(item));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[snakeToCamelKey(key)] = snakeToCamel(val);
    }
    return result;
  }

  return value;
}

// Recursively converts every object key from camelCase to snake_case.
// Arrays are walked (so each element is converted too); every other value
// (strings, numbers, booleans, null) is returned as-is.
export function camelToSnake(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => camelToSnake(item));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[camelToSnakeKey(key)] = camelToSnake(val);
    }
    return result;
  }

  return value;
}
