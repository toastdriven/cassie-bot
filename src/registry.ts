import type { IHandlerOptions, IRegistry } from './interfaces';

interface RegistryEntry<T> {
  handler: T;
  options: IHandlerOptions;
}

export class Registry<T> implements IRegistry<T> {
  _registered: Map<string, RegistryEntry<T>>;

  constructor() {
    this._registered = new Map<string, RegistryEntry<T>>();
  }

  register(name: string, options: IHandlerOptions = {}, func: T): void {
    if (this._registered.has(name)) {
      throw new Error(`${name} is already registered with a different command`);
    }

    this._registered.set(name, { handler: func, options });
  }

  unregister(name: string): T | undefined {
    const entry = this._registered.get(name);
    this._registered.delete(name);
    return entry?.handler;
  }

  // The options a handler was registered with (e.g. `description`, for a
  // /help responder to list). `undefined` if nothing is registered under
  // `name`.
  describe(name: string): IHandlerOptions | undefined {
    return this._registered.get(name)?.options;
  }

  // Lets Bot (or anything else) iterate `[name, handler]` pairs in
  // registration order, e.g. `for (const [name, handler] of registry)`.
  // Map preserves insertion order, so this is also what gives commands/
  // responders their "registration order" dispatch guarantee.
  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.entries();
  }

  *entries(): IterableIterator<[string, T]> {
    for (const [name, entry] of this._registered) {
      yield [name, entry.handler];
    }
  }

  // `[name, options]` pairs, in registration order -- for anything that
  // wants to describe what's registered (e.g. /help) without needing the
  // handler functions themselves.
  *list(): IterableIterator<[string, IHandlerOptions]> {
    for (const [name, entry] of this._registered) {
      yield [name, entry.options];
    }
  }
}
