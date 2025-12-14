#!/usr/bin/env bun
/**
 * Testing Library - Shared utilities for deploy & benchmark scripts
 */

import { $, serve, file, write } from "bun";
import { join } from "path";
import { rm, mkdir } from "node:fs/promises";
import puppeteer, { type Page, type Browser, type CDPSession } from "puppeteer-core";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface Config {
  projectDir: string;
  obsidianExe: string;
  vaultPluginDir: string;
  exportDir: string;
  pluginId: string;
  cdpPort: number;
  serverPort: number;
  timeouts: {
    cdp: number;
    modal: number;
    export: number;
    navigation: number;
    selector: number;
  };
}

export interface ObsidianConnection {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
}

export interface TimingStats {
  name: string;
  count: number;
  total: number;
  min: number;
  max: number;
  avg: number;
}

export interface JitterAnalysis {
  totalFrames: number;
  droppedFrames: number;          // Frames > 33ms (missed 30fps)
  jitterScore: number;            // 0-100, higher = worse jitter
  
  // Frame timing percentiles (ms)
  avgFrameTime: number;
  p95FrameTime: number;
  p99FrameTime: number;
  worstFrameTime: number;
  frameTimeVariance: number;      // Standard deviation
  
  // CSS-specific
  cssSpikes: number;              // Layout/recalc events > 16ms
  layoutThrashing: number;        // Back-to-back layout/recalc pairs
}

export interface ExportResult {
  success: boolean;
  defaultPage: string | null;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export function loadConfig(overrides: Partial<Config> = {}): Config | null {
  const vaultPluginDir = Bun.env.VAULT_PLUGIN_DIR;
  const exportDir = Bun.env.EXPORT_DIR;
  
  if (!vaultPluginDir || !exportDir) {
    console.error("❌ Missing VAULT_PLUGIN_DIR or EXPORT_DIR in .env");
    return null;
  }
  
  return {
    projectDir: Bun.env.PROJECT_DIR ?? process.cwd(),
    obsidianExe: Bun.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe",
    vaultPluginDir,
    exportDir,
    pluginId: "webpage-html-export",
    cdpPort: 9333,
    serverPort: 4300,
    timeouts: {
      cdp: 180_000,
      modal: 30_000,
      export: 300_000,
      navigation: 60_000,
      selector: 30_000,
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

export const sleep = (ms: number) => Bun.sleep(ms);

export async function killPort(port: number, cwd: string): Promise<void> {
  const result = await $`netstat -ano | findstr :${port} | findstr LISTENING`
    .cwd(cwd).nothrow().quiet();
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

export async function pollUntil(
  fn: () => Promise<boolean>,
  timeout: number,
  interval = 500
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

/**
 * Clear export directory while preserving .git folder
 */
export async function clearExportDir(exportDir: string): Promise<void> {
  const { existsSync } = await import("fs");
  const { readdir, rm } = await import("node:fs/promises");
  const { join } = await import("path");
  
  if (!existsSync(exportDir)) {
    await mkdir(exportDir, { recursive: true });
    return;
  }
  
  const entries = await readdir(exportDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue; // Preserve .git folder
    const fullPath = join(exportDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OBSIDIAN CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Focus Obsidian via CDP.
 */
export async function focusObsidian(conn: ObsidianConnection): Promise<void> {
  try { await conn.page.bringToFront(); } catch {}
}

/**
 * Minimize Obsidian window after export (cleans up off-screen window).
 */
export async function minimizeObsidian(): Promise<void> {
  const ps = `
$procs = Get-Process -Name Obsidian -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    if ($p.MainWindowHandle -ne 0) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MinHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
        [MinHelper]::ShowWindow($p.MainWindowHandle, 6)  # SW_MINIMIZE
    }
}
  `;
  await $`powershell -ExecutionPolicy Bypass -Command ${ps}`.nothrow().quiet();
}

export async function connectToObsidian(config: Config): Promise<ObsidianConnection | null> {
  const cdpUrl = `http://localhost:${config.cdpPort}`;
  
  // Check if Obsidian is running, start if not
  const isRunning = await fetch(`${cdpUrl}/json/version`).then(() => true).catch(() => false);
  
  if (!isRunning) {
    console.log("🚀 Starting Obsidian...");
    Bun.spawn([config.obsidianExe, `--remote-debugging-port=${config.cdpPort}`], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    
    const started = await pollUntil(
      async () => fetch(`${cdpUrl}/json/version`).then(() => true).catch(() => false),
      config.timeouts.cdp
    );
    if (!started) {
      console.error("❌ Failed to start Obsidian");
      return null;
    }
    
    // Extra wait for fresh start
    await sleep(2000);
  }
  
  console.log("✅ Obsidian running");
  
  // Connect with Puppeteer
  const browser = await puppeteer.connect({
    browserURL: cdpUrl,
    defaultViewport: null,
    protocolTimeout: config.timeouts.cdp,
  });
  
  // Get the main Obsidian page
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes("obsidian.md")) ?? pages[0];
  
  if (!page) {
    console.error("❌ No Obsidian page found");
    return null;
  }
  
  // Create CDP session for low-level control
  const cdp = await page.createCDPSession();
  const conn: ObsidianConnection = { browser, page, cdp };
  
  // Focus the window aggressively
  await focusObsidian(conn);
  
  // Wait for UI to be ready
  await page.waitForSelector(".side-dock-ribbon", { timeout: config.timeouts.cdp });
  console.log("✅ Obsidian UI ready");
  
  return conn;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD & DEPLOY
// ═══════════════════════════════════════════════════════════════════════════

export async function buildPlugin(config: Config): Promise<boolean> {
  console.log("🔨 Building...");
  
  const build = await $`bun esbuild.config.mjs production`
    .cwd(config.projectDir).nothrow();
  
  if (build.exitCode !== 0) {
    console.error("❌ Build failed");
    return false;
  }
  
  return true;
}

export async function deployPlugin(config: Config, page: Page): Promise<boolean> {
  console.log("📋 Deploying...");
  
  // Copy main.js to vault
  await write(
    join(config.vaultPluginDir, "main.js"),
    file(join(config.projectDir, "main.js"))
  );
  
  // Wait for plugins API
  await page.waitForFunction(
    () => !!(window as any).app?.plugins?.enablePlugin,
    { timeout: config.timeouts.cdp, polling: 100 }
  );
  
  // Hot-reload plugin
  console.log("🔄 Hot-reloading...");
  const result = await page.evaluate(async (id: string) => {
    const app = (window as any).app;
    if (!app?.plugins) return false;
    await app.plugins.disablePlugin(id);
    await app.plugins.enablePlugin(id);
    return true;
  }, config.pluginId);
  
  if (!result) {
    console.error("❌ Hot-reload failed");
    return false;
  }
  
  // Wait for plugin ribbon icon
  await page.waitForSelector('[aria-label="Export as HTML"]', {
    timeout: config.timeouts.selector,
    visible: true,
  });
  
  console.log("✅ Deployed");
  return true;
}

export async function buildAndDeploy(config: Config, page: Page): Promise<boolean> {
  if (!await buildPlugin(config)) return false;
  if (!await deployPlugin(config, page)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export async function runExport(
  config: Config,
  conn: ObsidianConnection,
  items: string[]
): Promise<ExportResult> {
  const { page } = conn;
  
  // Aggressively focus before export - critical for canvas rendering
  console.log("🔍 Focusing Obsidian for export...");
  await focusObsidian(conn);
  
  // Clear export directory (preserve .git folder)
  console.log("🗑️ Clearing export folder...");
  await clearExportDir(config.exportDir);
  
  // Determine default page (first canvas or first item)
  let firstCanvas: string | null = null;
  for (const path of items) {
    if (path.endsWith(".canvas")) {
      firstCanvas = `/${path.replace(".canvas", "")}.html`;
      break;
    }
    const isCanvas = await page.evaluate(
      (p: string) => !!(window as any).app?.vault?.getAbstractFileByPath(p + ".canvas"),
      path
    );
    if (isCanvas) {
      firstCanvas = `/${path}.html`;
      break;
    }
  }
  const defaultPage = firstCanvas || `/${items[0]}.html`;
  
  // Pre-configure export settings
  console.log("⚙️ Pre-configuring export settings...");
  const configResult = await page.evaluate(
    (items: string[], exportDir: string) => {
      const vault = (window as any).app?.vault;
      const plugin = (window as any).WebpageHTMLExport;
      if (!plugin?.settings?.exportOptions) {
        return { success: false, error: "Plugin settings not available" };
      }
      
      const resolvedPaths: string[] = [];
      for (const reqPath of items) {
        for (const ext of ["", ".md", ".canvas", ".html"]) {
          if (vault?.getAbstractFileByPath(reqPath + ext)) {
            resolvedPaths.push(reqPath + ext);
            break;
          }
        }
      }
      
      plugin.settings.exportOptions.filesToExport = resolvedPaths;
      plugin.settings.exportOptions.exportPath = exportDir;
      
      return { success: true, count: resolvedPaths.length };
    },
    items,
    config.exportDir
  );
  
  if (!configResult.success) {
    return { success: false, defaultPage: null, error: configResult.error };
  }
  
  // Open modal
  console.log("📂 Opening export modal...");
  await page.click('[aria-label="Export as HTML"]');
  
  await page.waitForSelector(".modal .tree-item", {
    timeout: config.timeouts.modal,
    visible: true,
  });
  
  await sleep(300);
  
  // Log selected files
  const selectedCount = await page.evaluate(() => 
    document.querySelectorAll('.modal .tree-item input[type="checkbox"]:checked').length
  );
  console.log(`☑️ Selected ${selectedCount} files`);
  for (const item of items) {
    console.log(`   ✓ ${item}${item.includes("canvas") ? " (canvas)" : ""}`);
  }
  
  // Find and click Export button
  const buttons = await page.$$(".modal button");
  for (const btn of buttons) {
    const text = await btn.evaluate(el => el.textContent);
    if (text?.includes("Export")) {
      await btn.click();
      break;
    }
  }
  
  console.log("🚀 Exporting...");
  console.log("⏳ Waiting for export...");
  
  // Wait for progress wrapper
  await page.waitForFunction(
    () => !!document.querySelector(".html-progress-wrapper"),
    { timeout: config.timeouts.modal, polling: 100 }
  ).catch(() => {/* Progress may not appear for small exports */});
  
  // Wait for completion
  try {
    await page.waitForFunction(
      () => {
        const progress = document.querySelector(".html-progress-wrapper");
        const notice = document.querySelector(".notice");
        return !progress || notice?.textContent?.includes("Finished");
      },
      { timeout: config.timeouts.export, polling: 200 }
    );
  } catch {
    return { success: false, defaultPage: null, error: "Export timed out" };
  }
  
  await sleep(1500);
  
  console.log("✅ Export complete!");
  return { success: true, defaultPage };
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════

export function startServer(config: Config, defaultPage: string, port?: number) {
  const serverPort = port ?? config.serverPort;
  
  const server = serve({
    port: serverPort,
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/" || path === "") path = defaultPage;
      
      const fullPath = join(config.exportDir, path);
      const f = file(fullPath);
      
      if (await f.exists()) {
        return new Response(f, {
          headers: { "Content-Type": f.type || "application/octet-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  
  console.log(`\n🌐 Server: http://localhost:${serverPort}`);
  console.log(`   Default: ${defaultPage}`);
  
  return server;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACE PARSING
// ═══════════════════════════════════════════════════════════════════════════

export function parseTraceBuffer(traceBuffer: Buffer): Map<string, TimingStats> {
  const trace = JSON.parse(new TextDecoder().decode(traceBuffer));
  return parseTraceEvents(trace.traceEvents || trace);
}

export function parseTraceEvents(events: any[]): Map<string, TimingStats> {
  // Extract user timing marks
  const marks = new Map<string, number[]>();
  for (const event of events) {
    if (event.cat === "blink.user_timing" && event.ph === "I") {
      const name = event.name;
      if (name.endsWith("-start") || name.endsWith("-end")) {
        if (!marks.has(name)) marks.set(name, []);
        marks.get(name)!.push(event.ts);
      }
    }
  }
  
  // Calculate durations from mark pairs
  const timings = new Map<string, number[]>();
  for (const [name, timestamps] of marks) {
    if (!name.endsWith("-start")) continue;
    const baseName = name.replace(/-start$/, "");
    const ends = marks.get(`${baseName}-end`) || [];
    
    const durations: number[] = [];
    for (let i = 0; i < Math.min(timestamps.length, ends.length); i++) {
      const dur = ends[i] - timestamps[i];
      if (dur > 0 && dur < 10_000_000) durations.push(dur);
    }
    
    if (durations.length > 0) {
      timings.set(baseName, durations);
    }
  }
  
  // Convert to stats
  const stats = new Map<string, TimingStats>();
  for (const [name, durations] of timings) {
    const total = durations.reduce((a, b) => a + b, 0);
    stats.set(name, {
      name,
      count: durations.length,
      total,
      min: Math.min(...durations),
      max: Math.max(...durations),
      avg: total / durations.length,
    });
  }
  
  return stats;
}

export function parseRenderingEvents(events: any[]): Map<string, TimingStats> {
  // Rendering event types we care about
  const renderingNames = [
    "Layout", "Paint", "UpdateLayoutTree", "RecalculateStyles",
    "HitTest", "CompositeLayers", "UpdateLayer"
  ];
  
  const durations = new Map<string, number[]>();
  
  for (const event of events) {
    if (event.cat?.includes("devtools.timeline") && event.ph === "X" && event.dur) {
      const name = event.name;
      if (renderingNames.includes(name)) {
        if (!durations.has(name)) durations.set(name, []);
        durations.get(name)!.push(event.dur);
      }
    }
  }
  
  const stats = new Map<string, TimingStats>();
  for (const [name, durs] of durations) {
    if (durs.length === 0) continue;
    const total = durs.reduce((a, b) => a + b, 0);
    stats.set(name, {
      name,
      count: durs.length,
      total,
      min: Math.min(...durs),
      max: Math.max(...durs),
      avg: total / durs.length,
    });
  }
  
  return stats;
}

export function formatMicros(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}µs`;
  if (us < 1000000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1000000).toFixed(2)}s`;
}

export function printTimingResults(stats: Map<string, TimingStats>, renderingStats?: Map<string, TimingStats>): void {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    USER TIMING RESULTS                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  
  if (stats.size === 0) {
    console.log("  No user timing marks found.");
    console.log("  Add performance.mark('name-start') / performance.mark('name-end') to your code.");
  } else {
    const sorted = [...stats.values()].sort((a, b) => b.total - a.total);
    const totalTime = sorted.reduce((a, s) => a + s.total, 0);
    
    console.log("  ┌────────────────────────┬────────┬──────────┬──────────┬──────────┬───────┐");
    console.log("  │ Measure                │ Count  │ Avg      │ Max      │ Total    │   %   │");
    console.log("  ├────────────────────────┼────────┼──────────┼──────────┼──────────┼───────┤");
    
    for (const s of sorted) {
      const name = s.name.slice(0, 22).padEnd(22);
      const count = s.count.toString().padStart(6);
      const avg = formatMicros(s.avg).padStart(8);
      const max = formatMicros(s.max).padStart(8);
      const total = formatMicros(s.total).padStart(8);
      const pct = ((s.total / totalTime) * 100).toFixed(1).padStart(5) + "%";
      console.log(`  │ ${name} │${count} │${avg} │${max} │${total} │${pct} │`);
    }
    
    console.log("  └────────────────────────┴────────┴──────────┴──────────┴──────────┴───────┘");
    console.log(`\n  Total measured time: ${formatMicros(totalTime)}`);
  }
  
  // Print rendering stats if available
  if (renderingStats && renderingStats.size > 0) {
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                    CSS/RENDERING STATS                         ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");
    
    const sorted = [...renderingStats.values()].sort((a, b) => b.total - a.total);
    const totalTime = sorted.reduce((a, s) => a + s.total, 0);
    
    console.log("  ┌────────────────────────┬────────┬──────────┬──────────┬──────────┬───────┐");
    console.log("  │ Rendering Phase        │ Count  │ Avg      │ Max      │ Total    │   %   │");
    console.log("  ├────────────────────────┼────────┼──────────┼──────────┼──────────┼───────┤");
    
    for (const s of sorted) {
      const name = s.name.slice(0, 22).padEnd(22);
      const count = s.count.toString().padStart(6);
      const avg = formatMicros(s.avg).padStart(8);
      const max = formatMicros(s.max).padStart(8);
      const total = formatMicros(s.total).padStart(8);
      const pct = ((s.total / totalTime) * 100).toFixed(1).padStart(5) + "%";
      console.log(`  │ ${name} │${count} │${avg} │${max} │${total} │${pct} │`);
    }
    
    console.log("  └────────────────────────┴────────┴──────────┴──────────┴──────────┴───────┘");
    console.log(`\n  Total rendering time: ${formatMicros(totalTime)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CPU PROFILE PARSING
// ═══════════════════════════════════════════════════════════════════════════

interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

interface FunctionStats {
  name: string;
  url: string;
  selfTime: number;      // microseconds
  hitCount: number;
  lineNumber: number;
}

/**
 * Parse V8 CPU profile and extract function-level timing.
 * Returns top N functions by self-time.
 */
export function parseCpuProfile(profile: CpuProfile, topN: number = 20): FunctionStats[] {
  const nodeMap = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }
  
  // Calculate self-time for each function based on samples
  const selfTimeMap = new Map<number, number>();
  
  for (let i = 0; i < (profile.samples?.length || 0); i++) {
    const nodeId = profile.samples![i];
    const delta = profile.timeDeltas?.[i] || 0;
    selfTimeMap.set(nodeId, (selfTimeMap.get(nodeId) || 0) + delta);
  }
  
  // Aggregate by function name + url (same function may appear multiple times)
  const functionMap = new Map<string, FunctionStats>();
  
  for (const [nodeId, selfTime] of selfTimeMap) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    
    const { functionName, url, lineNumber } = node.callFrame;
    
    // Skip internal/idle/GC nodes
    if (!functionName || functionName === '(idle)' || functionName === '(garbage collector)') continue;
    if (url.startsWith('native ') || url === '') continue;
    
    // Create unique key for function
    const key = `${functionName}@${url}:${lineNumber}`;
    
    const existing = functionMap.get(key);
    if (existing) {
      existing.selfTime += selfTime;
      existing.hitCount += node.hitCount ?? 0;
    } else {
      functionMap.set(key, {
        name: functionName,
        url: url.split('/').pop() || url,  // Just filename
        selfTime,
        hitCount: node.hitCount ?? 0,
        lineNumber,
      });
    }
  }
  
  // Sort by self-time descending
  const sorted = [...functionMap.values()].sort((a, b) => b.selfTime - a.selfTime);
  
  return sorted.slice(0, topN);
}

/**
 * Print CPU profile results in a formatted table.
 */
export function printCpuProfileResults(functions: FunctionStats[]): void {
  if (functions.length === 0) {
    console.log("\n  No function data captured. Profiler may not have sampled during test.\n");
    return;
  }
  
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    V8 CPU PROFILE (Top Functions)              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  
  const totalTime = functions.reduce((a, f) => a + f.selfTime, 0);
  
  console.log("  ┌────────────────────────────────┬────────────────────┬──────────┬───────┐");
  console.log("  │ Function                       │ File:Line          │ Self     │   %   │");
  console.log("  ├────────────────────────────────┼────────────────────┼──────────┼───────┤");
  
  for (const f of functions) {
    const name = f.name.slice(0, 30).padEnd(30);
    const location = `${f.url.slice(0, 15)}:${f.lineNumber}`.slice(0, 18).padEnd(18);
    const time = formatMicros(f.selfTime).padStart(8);
    const pct = ((f.selfTime / totalTime) * 100).toFixed(1).padStart(5) + "%";
    console.log(`  │ ${name} │ ${location} │${time} │${pct} │`);
  }
  
  console.log("  └────────────────────────────────┴────────────────────┴──────────┴───────┘");
  console.log(`\n  Total sampled time: ${formatMicros(totalTime)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// JITTER ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyze frame timing from trace events to detect jitter.
 * Returns percentile metrics (p95, p99, worst) and CSS spike detection.
 */
export function analyzeJitter(events: any[]): JitterAnalysis {
  const frameTimes: number[] = [];
  let lastFrameTs = 0;
  
  // Extract frame boundaries from Paint events (most reliable cross-browser)
  for (const event of events) {
    // Use Paint events as frame markers
    if (event.cat?.includes('devtools.timeline') && 
        (event.name === 'Paint' || event.name === 'FrameCommittedInBrowser' || event.name === 'DrawFrame')) {
      if (lastFrameTs > 0) {
        const delta = (event.ts - lastFrameTs) / 1000; // µs to ms
        if (delta > 0 && delta < 1000) frameTimes.push(delta);
      }
      lastFrameTs = event.ts;
    }
  }
  
  // Default return if no frames found
  if (frameTimes.length === 0) {
    return {
      totalFrames: 0,
      droppedFrames: 0,
      jitterScore: 0,
      avgFrameTime: 0,
      p95FrameTime: 0,
      p99FrameTime: 0,
      worstFrameTime: 0,
      frameTimeVariance: 0,
      cssSpikes: 0,
      layoutThrashing: 0,
    };
  }
  
  // Sort for percentile calculation
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p95idx = Math.floor(sorted.length * 0.95);
  const p99idx = Math.floor(sorted.length * 0.99);
  
  // Calculate stats
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const variance = Math.sqrt(
    frameTimes.reduce((sum, t) => sum + (t - avg) ** 2, 0) / frameTimes.length
  );
  
  // Count dropped frames (> 33ms = missed 30fps target)
  const droppedFrames = frameTimes.filter(t => t > 33).length;
  
  // CSS spikes and layout thrashing detection
  let cssSpikes = 0;
  let layoutThrashing = 0;
  let lastLayoutTs = 0;
  
  for (const event of events) {
    if (event.cat?.includes('devtools.timeline') && event.ph === 'X') {
      const dur = (event.dur || 0) / 1000; // µs to ms
      if ((event.name === 'Layout' || event.name === 'RecalculateStyles') && dur > 16) {
        cssSpikes++;
      }
      // Detect thrashing: Layout within 5ms of previous Layout
      if (event.name === 'Layout') {
        if (lastLayoutTs > 0 && (event.ts - lastLayoutTs) / 1000 < 5) {
          layoutThrashing++;
        }
        lastLayoutTs = event.ts;
      }
    }
  }
  
  // Find worst frame details
  let worstFrame = { start: 0, end: 0, duration: 0 };
  
  // Re-scan frames to find the specific worst one timestamp range
  let currentFrameStart = 0;
  for (const event of events) {
    if (event.cat?.includes('devtools.timeline') && 
        (event.name === 'Paint' || event.name === 'FrameCommittedInBrowser' || event.name === 'DrawFrame')) {
      if (currentFrameStart > 0) {
        const duration = (event.ts - currentFrameStart) / 1000;
        if (duration > worstFrame.duration && duration < 5000) {
          worstFrame = { start: currentFrameStart, end: event.ts, duration };
        }
      }
      currentFrameStart = event.ts;
    }
  }

  // Analyze events during worst frame
  const worstFrameEvents: { name: string, duration: number, args?: any }[] = [];
  if (worstFrame.duration > 0) {
     for (const event of events) {
        if (event.ts >= worstFrame.start && event.ts <= worstFrame.end && event.ph === 'X') {
           const dur = (event.dur || 0) / 1000;
           if (dur > 0.5) { // Capture events > 0.5ms
              worstFrameEvents.push({ name: event.name, duration: dur, args: event.args });
           }
        }
     }
  }
  
  // Sort events by duration
  worstFrameEvents.sort((a, b) => b.duration - a.duration);

  // Jitter score: weighted combination (0-100)
  const jitterScore = Math.min(100, Math.round(
    (droppedFrames / frameTimes.length) * 50 +
    (variance / 16.67) * 30 +
    (cssSpikes / Math.max(1, frameTimes.length)) * 20
  ));
  
  return {
    totalFrames: frameTimes.length,
    droppedFrames,
    jitterScore,
    avgFrameTime: avg,
    p95FrameTime: sorted[p95idx] || 0,
    p99FrameTime: sorted[p99idx] || 0,
    worstFrameTime: sorted[sorted.length - 1] || 0,
    frameTimeVariance: variance,
    cssSpikes,
    layoutThrashing,
    worstFrameEvents: worstFrameEvents.slice(0, 15), // Top 15 culprits
  } as any;
}

/**
 * Print jitter analysis in a formatted report.
 */
export function printJitterReport(analysis: any): void {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                      JITTER ANALYSIS                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  
  if (analysis.totalFrames === 0) {
    console.log("  No frame data captured. Tracing may not have captured frame events.");
    return;
  }
  
  const scoreEmoji = analysis.jitterScore < 20 ? '🟢' : 
                     analysis.jitterScore < 50 ? '🟡' : '🔴';
  
  console.log(`  ${scoreEmoji} Jitter Score: ${analysis.jitterScore}/100`);
  console.log(`     (0 = butter smooth, 100 = slideshow)\n`);
  
  console.log("  ┌─────────────────────┬────────────┐");
  console.log("  │ Frame Timing        │ Value      │");
  console.log("  ├─────────────────────┼────────────┤");
  console.log(`  │ Total Frames        │ ${analysis.totalFrames.toString().padStart(10)} │`);
  console.log(`  │ Dropped (>33ms)     │ ${analysis.droppedFrames.toString().padStart(10)} │`);
  console.log(`  │ Average             │ ${analysis.avgFrameTime.toFixed(2).padStart(7)}ms │`);
  console.log(`  │ P95                 │ ${analysis.p95FrameTime.toFixed(2).padStart(7)}ms │`);
  console.log(`  │ P99                 │ ${analysis.p99FrameTime.toFixed(2).padStart(7)}ms │`);
  console.log(`  │ Worst Frame         │ ${analysis.worstFrameTime.toFixed(2).padStart(7)}ms │`);
  console.log(`  │ Variance (σ)        │ ${analysis.frameTimeVariance.toFixed(2).padStart(7)}ms │`);
  console.log("  ├─────────────────────┼────────────┤");
  console.log(`  │ CSS Spikes (>16ms)  │ ${analysis.cssSpikes.toString().padStart(10)} │`);
  console.log(`  │ Layout Thrashing    │ ${analysis.layoutThrashing.toString().padStart(10)} │`);
  console.log("  └─────────────────────┴────────────┘");

  if (analysis.worstFrameEvents && analysis.worstFrameEvents.length > 0) {
    console.log("\n  🕵️  Worst Frame Inspection:");
    console.log("  ┌────────────────────────────────┬──────────┐");
    console.log("  │ Event                          │ Duration │");
    console.log("  ├────────────────────────────────┼──────────┤");
    for (const event of analysis.worstFrameEvents) {
       const duration = `${event.duration.toFixed(2)}ms`.padStart(8);
       console.log(`  │ ${event.name.padEnd(30)} │ ${duration} │`);
    }
    console.log("  └────────────────────────────────┴──────────┘");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export default {
  // Config
  loadConfig,
  
  // Process
  sleep,
  killPort,
  pollUntil,
  
  // Obsidian
  connectToObsidian,
  focusObsidian,
  buildPlugin,
  deployPlugin,
  buildAndDeploy,
  runExport,
  
  // Server
  startServer,
  
  // Trace
  parseTraceBuffer,
  parseTraceEvents,
  parseRenderingEvents,
  formatMicros,
  printTimingResults,
  
  // CPU Profile
  parseCpuProfile,
  printCpuProfileResults,
  
  // Jitter Analysis
  analyzeJitter,
  printJitterReport,
};
