import { Config } from './config';
import { Registry } from './registry';
import { Handler } from './types';

export class Bot {
  config: Config;
  listenerRegistry: Registry<Handler>;
  commandRegistry: Registry<Handler>;
  responderRegistry: Registry<Handler>;

  constructor(config: Config) {
    this.config = config;
    this.listenerRegistry = new Registry<Handler>();
    this.commandRegistry = new Registry<Handler>();
    this.responderRegistry = new Registry<Handler>();
  }

  registerListener(name: string, func: CallableFunction): void {
    this.listenerRegistry.register(name, func);
  }

  registerCommand(name: string, func: CallableFunction): void {
    this.commandRegistry.register(name, func);
  }

  registerResponder(name: string, func: CallableFunction): void {
    this.responderRegistry.register(name, func);
  }

  async onMessage(msg: ApronMessage): Promise<void> {
    // We always run all listeners.
    for (const handler in this.listenerRegistry) {
      handler(msg);
    }
  }
}
