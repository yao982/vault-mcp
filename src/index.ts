#!/usr/bin/env node
import { runCli } from "./cli.js";
runCli().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message }));
  else console.error(`Vault-MCP: ${message}`);
  process.exitCode = 1;
});
