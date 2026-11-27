import { Bot } from '../bot';
import type { IMessageContext } from '../interfaces';

// Deliberately naive: no caching, no retry, no handling of CoinGecko being
// down/rate-limited beyond "the request throws or the shape isn't what we
// expect, so don't reply."
// A fragile first built-in responder, not a production price feed.
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";

export default function (bot: Bot): void {
  bot.registerResponder(
    "ethereum-price",
    {
      description: 'Replies with the current price of Ethereum when a message mentions "ethereum" and "price"',
    },
    async (ctx: IMessageContext): Promise<boolean> => {
      // Ignore the bot's own messages -- otherwise a reply that happens to
      // contain both keywords (e.g. the help listing's own description
      // text for this responder) re-triggers itself.
      if (bot.you && ctx.message.from.userId === bot.you.userId) {
        return false;
      }

      const text = ctx.message.text.toLowerCase();
      if (!text.includes("ethereum") || !text.includes("price")) {
        return false;
      }

      let price: number | undefined;
      try {
        const response = await fetch(COINGECKO_URL);
        const data = await response.json() as { ethereum?: { usd?: number } };
        price = data.ethereum?.usd;
      } catch {
        // Network hiccup, CoinGecko down, unexpected response shape -- the
        // naive choice here is to say nothing rather than reply with an
        // error message. Revisit if that turns out to be confusing.
        return false;
      }

      if (typeof price !== "number") {
        return false;
      }

      await ctx.reply(`The current value of Ethereum is $${price}`);
      return true;
    }
  );
}
