import { Bot } from '../bot';
import type { IMessageContext } from '../interfaces';

export default function (bot: Bot): void {
  function generateHandlersResponse(): string {
    const handlers = bot.listHandlers()
      .filter(handler => handler.kind !== 'listener');
    const lines: string[] = handlers
      .map(h => `- **${h.name}:** ${h.description ?? "no description"}`);

    const body = lines.length > 0
      ? `Available commands/responders:\n${lines.join("\n")}`
      : "No commands/responders are currently registered.";
    return body;
  }

  bot.registerCommand(
    "/help",
    {
      description: 'Returns all the commands/responders this bot features',
    },
    async (ctx: IMessageContext): Promise<boolean> => {
      if (ctx.message.text.trim() !== "/help") {
        return false;
      }

      const body = generateHandlersResponse();
      await ctx.reply(body, { format: "markdown" });
      return true;
    }
  );

  bot.registerResponder(
    "help",
    {
      description: 'Returns all the commands/responders this bot features',
    },
    async (ctx: IMessageContext): Promise<boolean> => {
      // Mentions are a real list on the wire (Apron §3.5.5) -- never parsed
      // out of text, so check ctx.message.mentions against the bot's own
      // user_id, not a string match against "@<name>" (bot.you is an
      // object, and names can change/be absent anyway).
      const botUserId = bot.you?.userId;
      if (!botUserId || !ctx.message.mentions.includes(botUserId)) {
        return false;
      }

      const text = ctx.message.text.toLowerCase();
      if (!text.includes("help")) {
        return false;
      }

      const body = generateHandlersResponse();
      await ctx.reply(body, { format: "markdown" });
      return true;
    }
  );
}
