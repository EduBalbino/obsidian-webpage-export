#!/usr/bin/env bun
/**
 * Full Deploy & Export Automation
 * Usage: bun run go
 */

import { $, serve, file, write } from "bun";
import { join } from "path";
import { rm, mkdir } from "node:fs/promises";
import puppeteer, { type Page } from "puppeteer-core";

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  CONFIGURATION - EDIT THESE VALUES                                        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/** 
 * Items to export - supports paths like "folder/subfolder/item"
 * Parent folders are auto-expanded. First canvas = default page.
 */
const ITEMS_TO_EXPORT = [
  "testing_suite/amini-test/ultra-small-tester",   // Direct item
  "testing_suite/small-tester",     // Or use "folder/nested-item" for nested paths
  "LMI-canvas",
  "markdown"
];

/** Project paths - loaded from .env */
const PROJECT_DIR = Bun.env.PROJECT_DIR ?? process.cwd();
const OBSIDIAN_EXE = Bun.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";

// Validate required env vars
if (!Bun.env.VAULT_PLUGIN_DIR || !Bun.env.EXPORT_DIR) {
  console.error("❌ Missing required environment variables. Please create .env with:");
  console.error("   VAULT_PLUGIN_DIR=<path to vault plugin>");
  console.error("   EXPORT_DIR=<path to export folder>");
  console.error("   See .env.example for template, make it and send it to main dir as '.env'.");
  process.exit(1);
}

const VAULT_PLUGIN_DIR = Bun.env.VAULT_PLUGIN_DIR;
const EXPORT_DIR = Bun.env.EXPORT_DIR;

/** Plugin & Server */
const PLUGIN_ID = "webpage-html-export";
const CDP_PORT = 9333;
const CDP_URL = `http://localhost:${CDP_PORT}`;
const SERVER_PORT = 4300;

/** Timeouts (ms) */
const TIMEOUT_CDP = 30_000;
const TIMEOUT_MODAL = 10_000;
const TIMEOUT_EXPORT = 300_000;

// ═══════════════════════════════════════════════════════════════════════════
// KILL PORT
// ═══════════════════════════════════════════════════════════════════════════
async function killPort(port: number) {
  const result = await $`netstat -ano | findstr :${port} | findstr LISTENING`.cwd(PROJECT_DIR).nothrow().quiet();
  if (result.exitCode !== 0) return;
  
  const pids = [...new Set(
    result.text().trim().split("\n")
      .map(l => l.trim().split(/\s+/).pop())
      .filter((p): p is string => !!p && /^\d+$/.test(p) && p !== "0")
  )];
  
  for (const pid of pids) {
    await $`taskkill /PID ${pid} /F`.nothrow().quiet();
    console.log(`🛑 Killed PID ${pid}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OBSIDIAN CONNECTION
// ═══════════════════════════════════════════════════════════════════════════
async function getObsidianPage(): Promise<Page> {
  let needsStart = false;
  
  try {
    const resp = await fetch(`${CDP_URL}/json/version`);
    if (resp.ok) console.log("✅ Obsidian running");
  } catch {
    needsStart = true;
  }
  
  if (needsStart) {
    console.log("🚀 Starting Obsidian...");
    Bun.spawn([OBSIDIAN_EXE, `--remote-debugging-port=${CDP_PORT}`], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    
    // Poll for CDP readiness
    const start = Date.now();
    while (Date.now() - start < TIMEOUT_CDP) {
      try {
        const resp = await fetch(`${CDP_URL}/json/version`);
        if (resp.ok) break;
      } catch { /* not ready */ }
      await Bun.sleep(500);
    }
    console.log("✅ Obsidian started");
  }
  
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes("obsidian.md")) || pages[0];
  
  // Wait for Obsidian UI to be ready (sidebar icons exist)
  await page.waitForSelector('.side-dock-ribbon', { timeout: TIMEOUT_CDP });
  console.log("✅ Obsidian UI ready");
  
  return page;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD & DEPLOY
// ═══════════════════════════════════════════════════════════════════════════
async function buildAndDeploy(page: Page): Promise<boolean> {
  console.log("🔨 Building...");
  const build = await $`bun run build`.cwd(PROJECT_DIR).nothrow();
  if (build.exitCode !== 0) {
    console.log("❌ Build failed");
    return false;
  }
  
  console.log("📋 Deploying...");
  await write(join(VAULT_PLUGIN_DIR, "main.js"), file(join(PROJECT_DIR, "main.js")));
  
  // Wait for plugins API to be available
  await page.waitForFunction(
    () => !!(window as any).app?.plugins?.enablePlugin,
    { timeout: 30_000 }
  );
  
  console.log("🔄 Hot-reloading...");
  const result = await page.evaluate(async (id: string) => {
    const app = (window as any).app;
    if (!app?.plugins) return false;
    await app.plugins.disablePlugin(id);
    await app.plugins.enablePlugin(id);
    return true;
  }, PLUGIN_ID);
  
  if (!result) {
    console.log("❌ Hot-reload failed");
    return false;
  }
  
  // Wait for plugin to re-register its ribbon icon
  await page.waitForSelector('[aria-label="Export as HTML"]', { timeout: 5000 });
  console.log("✅ Deployed");
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT - Uses Proposal 1: Pre-populate Settings before opening modal
// ═══════════════════════════════════════════════════════════════════════════
async function runExport(page: Page): Promise<string | null> {
  console.log("🗑️ Clearing export folder...");
  await rm(EXPORT_DIR, { recursive: true, force: true });
  await mkdir(EXPORT_DIR, { recursive: true });
  
  // Determine default page (first canvas or first item)
  let firstCanvas: string | null = null;
  for (const path of ITEMS_TO_EXPORT) {
    if (path.endsWith(".canvas") || 
        await page.evaluate((p: string) => !!(window as any).app?.vault?.getAbstractFileByPath(p + ".canvas"), path)) {
      firstCanvas = `/${path}.html`;
      break;
    }
  }
  const defaultPage = firstCanvas || `/${ITEMS_TO_EXPORT[0]}.html`;

  // Pre-populate Settings.exportOptions.filesToExport BEFORE opening modal
  // The modal reads from this and calls setSelectedFiles() automatically
  console.log("⚙️ Pre-configuring export settings...");
  const configResult = await page.evaluate((items: string[], exportDir: string) => {
    const vault = (window as any).app?.vault;
    const plugin = (window as any).WebpageHTMLExport;
    if (!plugin?.settings?.exportOptions) return { success: false, error: "Plugin not found" };
    
    // Resolve paths with extensions (vault lookup)
    const resolvedPaths: string[] = [];
    for (const reqPath of items) {
      for (const ext of ['', '.md', '.canvas', '.html']) {
        if (vault?.getAbstractFileByPath(reqPath + ext)) {
          resolvedPaths.push(reqPath + ext);
          break;
        }
      }
    }
    
    plugin.settings.exportOptions.filesToExport = resolvedPaths;
    plugin.settings.exportOptions.exportPath = exportDir;
    
    return { success: true, count: resolvedPaths.length };
  }, ITEMS_TO_EXPORT, EXPORT_DIR);
  
  if (!configResult.success) {
    console.log(`❌ Config failed: ${configResult.error}`);
    return null;
  }
  
  // Open modal - it will auto-select from settings!
  console.log("📂 Opening export modal...");
  await page.evaluate(() => (document.querySelector('[aria-label="Export as HTML"]') as HTMLElement)?.click());
  await page.waitForSelector(".modal", { timeout: TIMEOUT_MODAL });
  await page.waitForSelector(".modal .tree-item", { timeout: TIMEOUT_MODAL });
  await Bun.sleep(300); // Brief pause for setSelectedFiles to complete
  
  // Verify selection
  const verified = await page.evaluate((expected: number) => {
    const checked = document.querySelectorAll('.modal .tree-item input[type="checkbox"]:checked').length;
    return { checked, expected, ok: checked >= expected };
  }, ITEMS_TO_EXPORT.length);
  
  console.log(`☑️ Selected ${verified.checked} files`);
  for (const path of ITEMS_TO_EXPORT) {
    const isCanvas = path.endsWith(".canvas") || firstCanvas?.includes(path);
    console.log(`   ✓ ${path}${isCanvas ? " (canvas)" : ""}`);
  }
  
  // Click Export button
  console.log("🚀 Exporting...");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.modal button'));
    (btns.find(b => b.textContent?.includes("Export")) as HTMLButtonElement)?.click();
  });
  
  // Wait for export completion
  console.log("⏳ Waiting for export...");
  try {
    await page.waitForFunction(() => !!document.querySelector(".html-progress-wrapper"), { timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(() => {
      const p = document.querySelector(".html-progress-wrapper");
      const n = document.querySelector(".notice");
      return !p || n?.textContent?.includes("Finished");
    }, { timeout: TIMEOUT_EXPORT });
    console.log("✅ Export complete!");
    return defaultPage;
  } catch {
    console.log("❌ Export timed out");
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEV SERVER
// ═══════════════════════════════════════════════════════════════════════════
function startServer(defaultPage: string) {
  serve({
    port: SERVER_PORT,
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/" || path === "") path = defaultPage;
      
      const f = file(join(EXPORT_DIR, path));
      if (await f.exists()) {
        return new Response(f, {
          headers: { "Content-Type": f.type || "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  
  console.log(`\n🌐 Server: http://localhost:${SERVER_PORT}`);
  console.log(`   Default: ${defaultPage}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n═══ DEPLOY & EXPORT ═══\n");
  const start = performance.now();
  
  await killPort(SERVER_PORT);
  
  const page = await getObsidianPage();
  if (!await buildAndDeploy(page)) process.exit(1);
  
  const defaultPage = await runExport(page);
  if (!defaultPage) process.exit(1);
  
  console.log(`\n✨ Done in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  startServer(defaultPage);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
