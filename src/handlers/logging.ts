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
      console.log(`[${now.toUTCString()}] ${from}: ${ctx.message.text}`);
    }
  );
}
