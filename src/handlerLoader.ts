import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import type { Bot } from "./bot";
import helpHandler from "./handlers/help";
import ethereumPriceHandler from "./handlers/ethereumPrice";
import loggingHandler from "./handlers/logging";

// Built-in handlers, shipped inside cassie-bot itself. Default-on; a name
// in Config.disabled skips it. Not loaded from disk like a user's
// handlers/ directory -- these are ordinary imports, already part of this
// package's own bundle.
const BUILTIN_HANDLERS: Record<string, (bot: Bot) => void> = {
  help: helpHandler,
  "ethereum-price": ethereumPriceHandler,
  logging: loggingHandler,
};

// jiti transpiles and `import()`s arbitrary TypeScript at runtime -- this
// is what lets a user's handlers/*.ts load under either Bun (which can
// already do this natively) or plain Node (which can't, without a loader).
// One instance is enough; it caches compiled output per file.
const jiti = createJiti(import.meta.url);

// Loads every handler a Config calls for: cassie-bot's own built-ins
// (minus config.disabled), then every .ts file directly inside the
// handlers/ directory next to the config file (Config.configPath's
// directory, not process.cwd() -- see Config's own docs on why).
//
// A user's handler file is expected to have a default export shaped like
// the built-ins: `export default function(bot: Bot): void { ... }`. A
// file missing that export, or one that throws while registering, fails
// the whole load (rather than silently skipping it) -- a bot that's
// missing a handler the operator asked for is a worse failure mode than
// a clear error at startup.
export async function loadHandlers(bot: Bot): Promise<void> {
  for (const [name, register] of Object.entries(BUILTIN_HANDLERS)) {
    if (bot.config.disabled.includes(name)) {
      continue;
    }
    register(bot);
  }

  const handlersDir = join(dirname(bot.config.configPath), "handlers");

  let entries;
  try {
    entries = await readdir(handlersDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No handlers/ directory at all is fine -- not every bot needs
      // custom handlers, especially one running only built-ins.
      return;
    }
    throw err;
  }

  const handlerFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of handlerFiles) {
    const filePath = join(handlersDir, fileName);
    const mod = await jiti.import(filePath, { default: true });

    if (typeof mod !== "function") {
      throw new Error(
        `${filePath} does not have a default export that's a function (bot: Bot) => void`,
      );
    }

    (mod as (bot: Bot) => void)(bot);
  }
}
