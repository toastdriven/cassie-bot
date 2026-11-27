export interface IRegistry {
  register(name: string, func: CallableFunction): void;
  unregister(name: string): CallableFunction | undefined;
}

export interface IMessageContext {

}
