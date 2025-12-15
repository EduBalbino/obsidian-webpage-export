#!/usr/bin/env bun
/**
 * Full Deploy & Export Automation
 * Usage: bun run go
 */

import lib from "./testing-lib";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const ITEMS_TO_EXPORT = ["LMI-canvas", "markdown"];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n═══ DEPLOY & EXPORT ═══\n");
  const start = performance.now();
  
  const config = lib.loadConfig();
  if (!config) process.exit(1);
  
  await lib.killPort(config.serverPort, config.projectDir);
  
  const conn = await lib.connectToObsidian(config);
  if (!conn) process.exit(1);
  
  if (!await lib.buildAndDeploy(config, conn.page)) process.exit(1);
  
  const result = await lib.runExport(config, conn, ITEMS_TO_EXPORT);
  if (!result.success || !result.defaultPage) {
    console.error(`❌ Export failed: ${result.error}`);
    process.exit(1);
  }
  
  console.log(`\n✨ Done in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  
  lib.startServer(config, result.defaultPage);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
