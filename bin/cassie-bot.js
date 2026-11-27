#!/usr/bin/env node
// The actual npm/bun "bin" entry (see package.json). This file itself must
// be plain JS -- `bin` scripts run directly via `node`/`bun`, before any
// of our own TypeScript-loading machinery exists yet. It does nothing but
// hand off to src/cli.ts via jiti, which is also what loads a consumer's
// own handlers/*.ts (see src/handlerLoader.ts) -- same problem, same fix.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli.ts", { default: false });

main().catch((err) => {
  console.error("cassie-bot: fatal error:", err);
  process.exit(1);
});
