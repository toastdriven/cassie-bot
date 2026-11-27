import { Bot } from '../bot';
import type { IMessageContext } from '../interfaces';

export default function (bot: Bot): void {
  bot.registerCommand(
    "/help",
    {
      description: 'Returns all the commands/responders this bot features',
    },
    async (ctx: IMessageContext): Promise<boolean> => {
      if (ctx.message.text.trim() !== "/help") {
        return false;
      }

      const handlers = bot.listHandlers()
        .filter(handler => handler.kind !== 'listener');
      const lines: string[] = handlers
        .map(h => `- **${h.name}:** ${h.description ?? "no description"}`);

      const body = lines.length > 0
        ? `Available commands/responders:\n${lines.join("\n")}`
        : "No commands/responders are currently registered.";

      await ctx.reply(body, { format: "markdown" });
      return true;
    }
  );
}
