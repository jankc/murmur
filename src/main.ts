// Daemon entry point — launched by the LaunchAgent: bun run src/main.ts
// (Equivalent to `murmur daemon`.)
import { loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";

await runDaemon(loadConfig());
