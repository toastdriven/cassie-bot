import { IRegistry } from './interfaces';

export class Registry {
  _registered: Map<string, CallableFunction>;

  constructor() {
    this._registered = new Map<string, CallableFunction>();
  }

  register(name: string, func: CallableFunction): void {
    if (this._registered.has(name)) {
      throw new Error(`${name} is already registered with a different command`);
    }

    this._registered.set(name, func);
  }

  unregister(name: string): CallableFunction | undefined {
    const oldFunc = this._registered.get(name);
    this._registered.delete(name);
    return oldFunc;
  }
}
