import type { IMessageContext } from './interfaces';

export type ListenerHandler = (ctx: IMessageContext) => Promise<void> | void;
export type CommandHandler = (ctx: IMessageContext) => Promise<boolean> | boolean;
export type ResponderHandler = (ctx: IMessageContext) => Promise<boolean> | boolean;
