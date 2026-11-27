import { Bot } from '../bot';
import type { IMessageContext } from '../interfaces';

export default function (bot: Bot): void {
  bot.registerListener(
    "logging",
    {
      description: 'A listener that logs all messages in chat.',
    },
    (ctx: IMessageContext): void => {
      const now = new Date();
      const from = ctx.message.from.name ?? ctx.message.from.userId;
      // roomId is undefined for the server's default room (IChatMessage,
      // interfaces.ts) -- label that case explicitly rather than printing
      // "undefined".
      const room = ctx.message.roomId ?? "default room";
      console.log(`[${now.toUTCString()}] [${room}] ${from}: ${ctx.message.text}`);
    }
  );
}
