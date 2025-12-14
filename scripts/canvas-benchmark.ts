#!/usr/bin/env bun
/**
 * Canvas Performance Benchmark
 * Captures performance.mark/measure timing from exported canvas
 * 
 * Usage: bun run benchmark
 */

import { writeFile } from "node:fs/promises";
import { join } from "path";
import puppeteer from "puppeteer-core";
import lib from "./testing-lib";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const ITEMS_TO_EXPORT = ["LMI-canvas"];
const BENCHMARK_PORT = 4301;
const CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARK
// ═══════════════════════════════════════════════════════════════════════════

async function runBenchmark(config: NonNullable<ReturnType<typeof lib.loadConfig>>, serverUrl: string) {
  console.log("\n═══ CANVAS BENCHMARK ═══\n");
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    defaultViewport: { width: 1280, height: 720 },
    args: [
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  
  try {
    await page.tracing.start({
      categories: [
        "blink.user_timing",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        // V8 CPU profiling for detailed function samples
        "disabled-by-default-v8.cpu_profiler",
        "disabled-by-default-v8.cpu_profiler.hires",
        "v8.execute",
        "v8",
      ],
    });
    
    console.log(`📄 Loading ${serverUrl}...`);
    
    await page.goto(serverUrl, {
      waitUntil: ["networkidle2", "domcontentloaded"],
      timeout: config.timeouts.navigation,
    });
    
    await page.waitForSelector(".canvas-wrapper, .canvas", {
      timeout: config.timeouts.selector,
      visible: true,
    });
    
    await lib.sleep(2000);
    
    // Start V8 CPU profiler via CDP
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    console.log("🔬 V8 CPU profiler started");
    
    console.log("▶️ Running stress test...");
    
    // Helper: quick circular pan (smaller, faster)
    const quickCircle = async () => {
      await page.mouse.move(640, 360);
      await page.mouse.down();
      for (let p = 0; p < 4; p++) {
        const angle = (p / 4) * Math.PI * 2;
        await page.mouse.move(
          640 + Math.cos(angle) * 60,
          360 + Math.sin(angle) * 40,
          { steps: 3 }
        );
        await lib.sleep(30);
      }
      await page.mouse.up();
    };
    
    // Helper: quick zoom
    const quickZoomIn = async () => {
      for (let z = 0; z < 3; z++) {
        await page.mouse.wheel({ deltaY: -120 });
        await lib.sleep(40);
      }
    };
    const quickZoomOut = async () => {
      for (let z = 0; z < 3; z++) {
        await page.mouse.wheel({ deltaY: 120 });
        await lib.sleep(40);
      }
    };
    
    // Pattern: circle → zoom in → circle → zoom in → circle → zoom in → circle
    await quickCircle();
    await quickZoomIn();
    await quickCircle();
    await quickZoomIn();
    await quickCircle();
    await quickZoomIn();
    await quickCircle();
    
    // Rapid zoom toggles: zoom out → zoom in → zoom out → zoom in
    await quickZoomOut();
    await quickZoomIn();
    await quickZoomOut();
    await quickZoomIn();
    
    // Stop V8 CPU profiler and get profile
    const cpuProfile = await cdp.send("Profiler.stop");
    await cdp.send("Profiler.disable");
    console.log("🔬 V8 CPU profiler stopped");
    
    // Save CPU profile
    await writeFile(
      join(config.projectDir, "benchmark-cpuprofile.json"),
      JSON.stringify(cpuProfile.profile, null, 2)
    );
    console.log("📁 CPU profile saved: benchmark-cpuprofile.json");
    
    // Parse CPU profile for function-level stats
    const cpuFunctions = lib.parseCpuProfile(cpuProfile.profile, 25);
    
    // Stop tracing and parse
    const traceBuffer = await page.tracing.stop();
    if (!traceBuffer) {
      console.error("❌ No trace buffer returned");
      return { userTiming: new Map(), rendering: new Map(), cpuFunctions: [], jitterAnalysis: lib.analyzeJitter([]) };
    }
    
    // Save trace
    const trace = JSON.parse(new TextDecoder().decode(traceBuffer));
    await writeFile(
      join(config.projectDir, "benchmark-trace.json"),
      JSON.stringify(trace, null, 2)
    );
    console.log("📁 Trace saved: benchmark-trace.json");
    
    // Parse user timing, rendering events, and jitter analysis
    const events = trace.traceEvents || [];
    return {
      userTiming: lib.parseTraceEvents(events),
      rendering: lib.parseRenderingEvents(events),
      cpuFunctions,
      jitterAnalysis: lib.analyzeJitter(events),
    };
    
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const config = lib.loadConfig();
  if (!config) process.exit(1);
  
  await lib.killPort(BENCHMARK_PORT, config.projectDir);
  
  const conn = await lib.connectToObsidian(config);
  if (!conn) process.exit(1);
  
  try {
    if (!await lib.buildAndDeploy(config, conn.page)) process.exit(1);
    
    const result = await lib.runExport(config, conn, ITEMS_TO_EXPORT);
    if (!result.success || !result.defaultPage) {
      console.error(`❌ Export failed: ${result.error}`);
      process.exit(1);
    }
    
    const server = lib.startServer(config, result.defaultPage, BENCHMARK_PORT);
    await lib.sleep(500);
    
    const stats = await runBenchmark(
      config,
      `http://localhost:${BENCHMARK_PORT}${result.defaultPage}`
    );
    
    lib.printTimingResults(stats.userTiming, stats.rendering);
    lib.printCpuProfileResults(stats.cpuFunctions);
    lib.printJitterReport(stats.jitterAnalysis);
    
    server.stop();
  } finally {
    conn.browser.disconnect();
  }
  
  console.log("\n✨ Done");
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
