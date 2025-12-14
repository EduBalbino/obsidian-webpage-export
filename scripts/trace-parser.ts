#!/usr/bin/env bun
/**
 * Advanced Trace Parser - Deep Chrome DevTools trace analysis
 * 
 * Extracts and displays:
 * - JavaScript function profiling (V8 samples)
 * - Long tasks with call stack attribution
 * - Rendering pipeline breakdown (Layout, Paint, Style, Composite)
 * - Event handler timing
 * - Frame timing analysis
 * - GPU activity
 * - Memory/GC pressure
 * 
 * Usage: bun run scripts/trace-parser.ts [trace.json]
 */

import { readFileSync } from "fs";

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;  // B=begin, E=end, X=complete, I=instant, etc.
  ts: number;  // timestamp in microseconds
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, any>;
  s?: string;  // scope
  tdur?: number; // thread duration
}

interface FunctionProfile {
  name: string;
  url: string;
  selfTime: number;
  totalTime: number;
  hitCount: number;
  line?: number;
  column?: number;
}

interface LongTask {
  name: string;
  duration: number;
  startTime: number;
  breakdown: Map<string, number>;
  topFunction?: string;
  callStack: string[];
}

interface FrameInfo {
  startTime: number;
  duration: number;
  scriptTime: number;
  layoutTime: number;
  paintTime: number;
  styleTime: number;
  idleTime: number;
}

interface EventHandlerInfo {
  type: string;
  duration: number;
  function?: string;
  target?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// PARSING HELPERS
// ════════════════════════════════════════════════════════════════════════════

function parseFunctionName(data: any): string {
  if (!data) return "<unknown>";
  if (data.functionName) {
    const name = data.functionName || "(anonymous)";
    if (data.url) {
      const file = data.url.split("/").pop()?.split("?")[0] || data.url;
      const loc = data.lineNumber ? `:${data.lineNumber}` : "";
      return `${name} (${file}${loc})`;
    }
    return name;
  }
  return data.name || "<unknown>";
}

function shortenPath(url: string | undefined, maxLen = 40): string {
  if (!url) return "";
  // Remove query strings and common prefixes
  let clean = url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
  if (clean.length > maxLen) {
    clean = "…" + clean.slice(-maxLen + 1);
  }
  return clean;
}

function formatMicros(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}µs`;
  if (us < 1000000) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1000000).toFixed(2)}s`;
}

function formatPercent(value: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((value / total) * 100).toFixed(1) + "%";
}

// ════════════════════════════════════════════════════════════════════════════
// TRACE ANALYSIS
// ════════════════════════════════════════════════════════════════════════════

class TraceAnalyzer {
  private events: TraceEvent[];
  private mainPid: number = 0;
  private mainTid: number = 0;
  
  constructor(events: TraceEvent[]) {
    this.events = events;
    this.findMainThread();
  }
  
  private findMainThread(): void {
    // Find the renderer main thread (has most events, or look for specific markers)
    const threadCounts = new Map<string, number>();
    for (const e of this.events) {
      const key = `${e.pid}:${e.tid}`;
      threadCounts.set(key, (threadCounts.get(key) || 0) + 1);
    }
    
    // Find thread with most timeline events
    let maxCount = 0;
    for (const [key, count] of threadCounts) {
      if (count > maxCount) {
        maxCount = count;
        const [pid, tid] = key.split(":").map(Number);
        this.mainPid = pid;
        this.mainTid = tid;
      }
    }
  }
  
  private isMainThread(e: TraceEvent): boolean {
    return e.pid === this.mainPid && e.tid === this.mainTid;
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // USER TIMING (performance.mark/measure)
  // ──────────────────────────────────────────────────────────────────────────
  
  parseUserTiming(): Map<string, { count: number; total: number; avg: number; min: number; max: number; samples: number[] }> {
    const marks = new Map<string, number[]>();
    
    for (const e of this.events) {
      if (e.cat === "blink.user_timing" && e.ph === "I") {
        if (!marks.has(e.name)) marks.set(e.name, []);
        marks.get(e.name)!.push(e.ts);
      }
    }
    
    const stats = new Map<string, { count: number; total: number; avg: number; min: number; max: number; samples: number[] }>();
    
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
        const total = durations.reduce((a, b) => a + b, 0);
        stats.set(baseName, {
          count: durations.length,
          total,
          avg: total / durations.length,
          min: Math.min(...durations),
          max: Math.max(...durations),
          samples: durations.slice(0, 10), // Keep first 10 for histogram
        });
      }
    }
    
    return stats;
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // RENDERING PIPELINE
  // ──────────────────────────────────────────────────────────────────────────
  
  parseRenderingEvents(): Map<string, { count: number; total: number; avg: number; min: number; max: number; p95: number }> {
    const categories = [
      "Layout", "Paint", "UpdateLayoutTree", "RecalculateStyles",
      "HitTest", "CompositeLayers", "UpdateLayer", "PrePaint",
      "Layerize", "Commit", "RasterTask", "ImageDecodeTask",
      "ParseHTML", "ScrollLayer"
    ];
    
    const durations = new Map<string, number[]>();
    
    for (const e of this.events) {
      if (e.cat?.includes("devtools.timeline") && e.ph === "X" && e.dur) {
        if (categories.includes(e.name)) {
          if (!durations.has(e.name)) durations.set(e.name, []);
          durations.get(e.name)!.push(e.dur);
        }
      }
    }
    
    const stats = new Map<string, { count: number; total: number; avg: number; min: number; max: number; p95: number }>();
    
    for (const [name, durs] of durations) {
      if (durs.length === 0) continue;
      const sorted = [...durs].sort((a, b) => a - b);
      const total = durs.reduce((a, b) => a + b, 0);
      const p95Index = Math.floor(sorted.length * 0.95);
      
      stats.set(name, {
        count: durs.length,
        total,
        avg: total / durs.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p95: sorted[p95Index] || sorted[sorted.length - 1],
      });
    }
    
    return stats;
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // JAVASCRIPT PROFILING (V8 SAMPLES)
  // ──────────────────────────────────────────────────────────────────────────
  
  parseJSProfile(): FunctionProfile[] {
    const profiles: FunctionProfile[] = [];
    const functionTimes = new Map<string, { selfTime: number; totalTime: number; hitCount: number; url: string; line?: number }>();
    
    // Look for FunctionCall events with detailed call info
    for (const e of this.events) {
      if (e.name === "FunctionCall" && e.ph === "X" && e.dur && this.isMainThread(e)) {
        const data = e.args?.data;
        if (data) {
          const funcName = parseFunctionName(data);
          const existing = functionTimes.get(funcName) || { selfTime: 0, totalTime: 0, hitCount: 0, url: data.url || "", line: data.lineNumber };
          existing.totalTime += e.dur;
          existing.selfTime += e.dur; // Approximate, would need call tree for accurate self time
          existing.hitCount++;
          functionTimes.set(funcName, existing);
        }
      }
      
      // Also look for EvaluateScript events
      if (e.name === "EvaluateScript" && e.ph === "X" && e.dur && this.isMainThread(e)) {
        const url = e.args?.data?.url || "inline script";
        const funcName = `<script> (${shortenPath(url)})`;
        const existing = functionTimes.get(funcName) || { selfTime: 0, totalTime: 0, hitCount: 0, url, line: undefined };
        existing.totalTime += e.dur;
        existing.selfTime += e.dur;
        existing.hitCount++;
        functionTimes.set(funcName, existing);
      }
    }
    
    // Convert to array and sort by total time
    for (const [name, data] of functionTimes) {
      profiles.push({
        name,
        url: data.url,
        selfTime: data.selfTime,
        totalTime: data.totalTime,
        hitCount: data.hitCount,
        line: data.line,
      });
    }
    
    return profiles.sort((a, b) => b.totalTime - a.totalTime);
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // V8 CPU PROFILE (ProfileChunk sampling data)
  // ──────────────────────────────────────────────────────────────────────────
  
  parseV8CpuProfile(): { functions: FunctionProfile[]; totalSamples: number; sampleInterval: number } {
    // V8 ProfileChunk events contain detailed CPU sampling data
    // Structure: { cpuProfile: { nodes: [...], samples: [...], timeDeltas: [...] }, timeOffset, ... }
    
    const nodeMap = new Map<number, { 
      functionName: string; 
      url: string; 
      lineNumber?: number; 
      columnNumber?: number;
      hitCount: number;
      selfTime: number;
      parentId?: number;
    }>();
    
    let samples: number[] = [];
    let timeDeltas: number[] = [];
    let sampleInterval = 100; // default 100µs
    
    for (const e of this.events) {
      // Profile event contains initial node definitions
      if ((e.name === "Profile" || e.name === "CpuProfile") && e.args?.data?.cpuProfile) {
        const profile = e.args.data.cpuProfile;
        if (profile.nodes) {
          for (const node of profile.nodes) {
            const callFrame = node.callFrame || {};
            nodeMap.set(node.id, {
              functionName: callFrame.functionName || "(anonymous)",
              url: callFrame.url || "",
              lineNumber: callFrame.lineNumber,
              columnNumber: callFrame.columnNumber,
              hitCount: node.hitCount || 0,
              selfTime: 0,
              parentId: node.parent,
            });
          }
        }
        if (profile.samples) samples.push(...profile.samples);
        if (profile.timeDeltas) timeDeltas.push(...profile.timeDeltas);
      }
      
      // ProfileChunk contains incremental samples
      if (e.name === "ProfileChunk" && e.args?.data?.cpuProfile) {
        const chunk = e.args.data.cpuProfile;
        if (chunk.nodes) {
          for (const node of chunk.nodes) {
            const callFrame = node.callFrame || {};
            if (!nodeMap.has(node.id)) {
              nodeMap.set(node.id, {
                functionName: callFrame.functionName || "(anonymous)",
                url: callFrame.url || "",
                lineNumber: callFrame.lineNumber,
                columnNumber: callFrame.columnNumber,
                hitCount: 0,
                selfTime: 0,
                parentId: node.parent,
              });
            }
          }
        }
        if (chunk.samples) samples.push(...chunk.samples);
        if (chunk.timeDeltas) timeDeltas.push(...chunk.timeDeltas);
      }
    }
    
    // No profile data found
    if (nodeMap.size === 0 || samples.length === 0) {
      return { functions: [], totalSamples: 0, sampleInterval };
    }
    
    // Calculate self time from samples
    // Each sample points to a node ID, and the delta is the time spent in that sample
    for (let i = 0; i < samples.length && i < timeDeltas.length; i++) {
      const nodeId = samples[i];
      const delta = timeDeltas[i];
      const node = nodeMap.get(nodeId);
      if (node && delta > 0) {
        node.selfTime += delta;
        node.hitCount++;
      }
    }
    
    // Aggregate by function name + url + line (dedup across nodes)
    const aggregated = new Map<string, { selfTime: number; hitCount: number; url: string; line?: number }>();
    
    for (const node of nodeMap.values()) {
      // Skip synthetic nodes like (root), (idle), (program), (garbage collector)
      if (node.functionName.startsWith("(") && node.functionName.endsWith(")")) continue;
      if (!node.functionName || node.selfTime === 0) continue;
      
      const key = `${node.functionName}|${shortenPath(node.url)}|${node.lineNumber || 0}`;
      const file = node.url.split("/").pop()?.split("?")[0] || "";
      const loc = node.lineNumber ? `:${node.lineNumber}` : "";
      const displayName = file ? `${node.functionName} (${file}${loc})` : node.functionName;
      
      const existing = aggregated.get(key) || { selfTime: 0, hitCount: 0, url: node.url, line: node.lineNumber };
      existing.selfTime += node.selfTime;
      existing.hitCount += node.hitCount;
      
      // Store with display name as key for final output
      aggregated.set(displayName, existing);
    }
    
    const functions: FunctionProfile[] = [];
    for (const [name, data] of aggregated) {
      functions.push({
        name,
        url: data.url,
        selfTime: data.selfTime,
        totalTime: data.selfTime, // Self time only from sampling
        hitCount: data.hitCount,
        line: data.line,
      });
    }
    
    return {
      functions: functions.sort((a, b) => b.selfTime - a.selfTime),
      totalSamples: samples.length,
      sampleInterval,
    };
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // LONG TASKS (>50ms)
  // ──────────────────────────────────────────────────────────────────────────
  
  parseLongTasks(): LongTask[] {
    const longTasks: LongTask[] = [];
    const LONG_TASK_THRESHOLD = 50_000; // 50ms in microseconds
    
    // Find Task events or RunTask events
    for (const e of this.events) {
      if ((e.name === "RunTask" || e.name === "Task" || e.name === "ThreadControllerImpl::RunTask") 
          && e.ph === "X" && e.dur && e.dur > LONG_TASK_THRESHOLD && this.isMainThread(e)) {
        
        // Find what's inside this task
        const taskStart = e.ts;
        const taskEnd = e.ts + e.dur;
        const breakdown = new Map<string, number>();
        const callStack: string[] = [];
        
        for (const inner of this.events) {
          if (inner.ts >= taskStart && inner.ts < taskEnd && 
              inner.ph === "X" && inner.dur && this.isMainThread(inner)) {
            const category = this.categorizeEvent(inner);
            breakdown.set(category, (breakdown.get(category) || 0) + inner.dur);
            
            if (inner.name === "FunctionCall" && inner.args?.data) {
              callStack.push(parseFunctionName(inner.args.data));
            }
          }
        }
        
        longTasks.push({
          name: e.name,
          duration: e.dur,
          startTime: e.ts,
          breakdown,
          topFunction: callStack[0],
          callStack: callStack.slice(0, 5),
        });
      }
    }
    
    // Also identify long script execution even without explicit Task wrapper
    for (const e of this.events) {
      if ((e.name === "FunctionCall" || e.name === "EvaluateScript") 
          && e.ph === "X" && e.dur && e.dur > LONG_TASK_THRESHOLD && this.isMainThread(e)) {
        
        // Check if not already covered by a Task
        const alreadyCovered = longTasks.some(t => 
          t.startTime <= e.ts && t.startTime + t.duration >= e.ts + e.dur
        );
        
        if (!alreadyCovered) {
          longTasks.push({
            name: e.name,
            duration: e.dur,
            startTime: e.ts,
            breakdown: new Map([[this.categorizeEvent(e), e.dur]]),
            topFunction: e.name === "FunctionCall" ? parseFunctionName(e.args?.data) : undefined,
            callStack: [],
          });
        }
      }
    }
    
    return longTasks.sort((a, b) => b.duration - a.duration);
  }
  
  private categorizeEvent(e: TraceEvent): string {
    const name = e.name;
    if (["Layout", "UpdateLayoutTree"].includes(name)) return "Layout";
    if (["Paint", "PrePaint", "Layerize"].includes(name)) return "Paint";
    if (["RecalculateStyles", "UpdateLayerTree"].includes(name)) return "Style";
    if (["CompositeLayers", "Commit", "RasterTask"].includes(name)) return "Composite";
    if (["ParseHTML"].includes(name)) return "Parse";
    if (["FunctionCall", "EvaluateScript", "v8.run"].includes(name)) return "Script";
    if (["GCEvent", "MinorGC", "MajorGC", "V8.GC*"].some(p => name.includes(p))) return "GC";
    return "Other";
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // EVENT HANDLERS
  // ──────────────────────────────────────────────────────────────────────────
  
  parseEventHandlers(): EventHandlerInfo[] {
    const handlers: EventHandlerInfo[] = [];
    
    for (const e of this.events) {
      if (e.name === "EventDispatch" && e.ph === "X" && e.dur && this.isMainThread(e)) {
        const type = e.args?.data?.type || "unknown";
        handlers.push({
          type,
          duration: e.dur,
          function: undefined,
          target: undefined,
        });
      }
    }
    
    return handlers.sort((a, b) => b.duration - a.duration);
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // FRAME ANALYSIS
  // ──────────────────────────────────────────────────────────────────────────
  
  parseFrames(): FrameInfo[] {
    const frames: FrameInfo[] = [];
    const frameEvents: TraceEvent[] = [];
    
    // Find BeginFrame/DrawFrame pairs
    for (const e of this.events) {
      if ((e.name === "BeginMainThreadFrame" || e.name === "DrawFrame" || e.name === "BeginFrame") 
          && this.isMainThread(e)) {
        frameEvents.push(e);
      }
    }
    
    // Analyze frame intervals
    const beginFrames = frameEvents.filter(e => e.name.includes("Begin")).sort((a, b) => a.ts - b.ts);
    
    for (let i = 0; i < beginFrames.length - 1; i++) {
      const start = beginFrames[i].ts;
      const end = beginFrames[i + 1].ts;
      const duration = end - start;
      
      // Sum up time spent in each category during this frame
      let scriptTime = 0, layoutTime = 0, paintTime = 0, styleTime = 0;
      
      for (const e of this.events) {
        if (e.ts >= start && e.ts < end && e.ph === "X" && e.dur && this.isMainThread(e)) {
          switch (this.categorizeEvent(e)) {
            case "Script": scriptTime += e.dur; break;
            case "Layout": layoutTime += e.dur; break;
            case "Paint": paintTime += e.dur; break;
            case "Style": styleTime += e.dur; break;
          }
        }
      }
      
      const activeTime = scriptTime + layoutTime + paintTime + styleTime;
      
      frames.push({
        startTime: start,
        duration,
        scriptTime,
        layoutTime,
        paintTime,
        styleTime,
        idleTime: Math.max(0, duration - activeTime),
      });
    }
    
    return frames;
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // GC ANALYSIS
  // ──────────────────────────────────────────────────────────────────────────
  
  parseGC(): { count: number; totalTime: number; events: { type: string; duration: number; usedHeapBefore?: number; usedHeapAfter?: number }[] } {
    const gcEvents: { type: string; duration: number; usedHeapBefore?: number; usedHeapAfter?: number }[] = [];
    
    for (const e of this.events) {
      if ((e.name.includes("GC") || e.name === "MinorGC" || e.name === "MajorGC" || e.name === "V8.GCScavenger" || e.name === "V8.GCCompactor")
          && e.ph === "X" && e.dur) {
        gcEvents.push({
          type: e.name,
          duration: e.dur,
          usedHeapBefore: e.args?.usedHeapSizeBefore,
          usedHeapAfter: e.args?.usedHeapSizeAfter,
        });
      }
    }
    
    return {
      count: gcEvents.length,
      totalTime: gcEvents.reduce((a, b) => a + b.duration, 0),
      events: gcEvents.sort((a, b) => b.duration - a.duration),
    };
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // FORCED REFLOWS / LAYOUT THRASHING
  // ──────────────────────────────────────────────────────────────────────────
  
  parseForcedReflows(): { count: number; totalTime: number; examples: { duration: number; stack?: string }[] } {
    const reflows: { duration: number; stack?: string }[] = [];
    
    for (const e of this.events) {
      // Look for Layout events that have "forced" flag or occur during script
      if (e.name === "Layout" && e.ph === "X" && e.dur) {
        // Check if this layout was forced (has stackTrace in args)
        if (e.args?.beginData?.stackTrace || e.args?.data?.stackTrace) {
          const stack = e.args?.beginData?.stackTrace?.[0] || e.args?.data?.stackTrace?.[0];
          reflows.push({
            duration: e.dur,
            stack: stack ? `${stack.functionName} (${shortenPath(stack.url)}:${stack.lineNumber})` : undefined,
          });
        }
      }
    }
    
    return {
      count: reflows.length,
      totalTime: reflows.reduce((a, b) => a + b.duration, 0),
      examples: reflows.sort((a, b) => b.duration - a.duration).slice(0, 10),
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TABLE RENDERING
// ════════════════════════════════════════════════════════════════════════════

function renderTable(title: string, headers: string[], rows: (string | number)[][], maxRows = 20): void {
  if (rows.length === 0) {
    console.log(`\n${title}\n  (no data)\n`);
    return;
  }
  
  // Calculate column widths
  const widths = headers.map((h, i) => {
    const dataMax = Math.max(...rows.map(r => String(r[i]).length));
    return Math.max(h.length, dataMax, 4);
  });
  
  // Render
  console.log(`\n╔${"═".repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1)}╗`);
  console.log(`║ ${title.padEnd(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1)} ║`);
  console.log(`╠${"═".repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1)}╣`);
  
  // Headers
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(" │ ");
  console.log(`║ ${headerLine} ║`);
  console.log(`╟${"─".repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1)}╢`);
  
  // Data rows
  const displayRows = rows.slice(0, maxRows);
  for (const row of displayRows) {
    const line = row.map((cell, i) => {
      const str = String(cell);
      return typeof cell === "number" ? str.padStart(widths[i]) : str.padEnd(widths[i]);
    }).join(" │ ");
    console.log(`║ ${line} ║`);
  }
  
  if (rows.length > maxRows) {
    const moreLine = `... and ${rows.length - maxRows} more rows`;
    console.log(`║ ${moreLine.padEnd(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1)} ║`);
  }
  
  console.log(`╚${"═".repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1)}╝`);
}

function renderSummaryBox(title: string, items: [string, string][]): void {
  const maxKeyLen = Math.max(...items.map(([k]) => k.length));
  const maxValLen = Math.max(...items.map(([, v]) => v.length));
  const width = maxKeyLen + maxValLen + 5;
  
  console.log(`\n┌${"─".repeat(width)}┐`);
  console.log(`│ ${title.padEnd(width - 2)} │`);
  console.log(`├${"─".repeat(width)}┤`);
  for (const [key, value] of items) {
    console.log(`│ ${key.padEnd(maxKeyLen)} : ${value.padStart(maxValLen)} │`);
  }
  console.log(`└${"─".repeat(width)}┘`);
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN REPORT GENERATION
// ════════════════════════════════════════════════════════════════════════════

function generateReport(analyzer: TraceAnalyzer): void {
  console.log("\n" + "═".repeat(80));
  console.log("                    ADVANCED TRACE ANALYSIS REPORT");
  console.log("═".repeat(80));
  
  // ─────────────────────────────────────────────────────────────────────────
  // 1. USER TIMING
  // ─────────────────────────────────────────────────────────────────────────
  const userTiming = analyzer.parseUserTiming();
  if (userTiming.size > 0) {
    const rows = [...userTiming.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, s]) => [
        name.slice(0, 30),
        s.count,
        formatMicros(s.avg),
        formatMicros(s.min),
        formatMicros(s.max),
        formatMicros(s.total),
        formatPercent(s.total, [...userTiming.values()].reduce((a, b) => a + b.total, 0)),
      ]);
    
    renderTable("USER TIMING (performance.mark pairs)", 
      ["Measure", "Count", "Avg", "Min", "Max", "Total", "%"],
      rows, 15);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 2. RENDERING PIPELINE
  // ─────────────────────────────────────────────────────────────────────────
  const rendering = analyzer.parseRenderingEvents();
  if (rendering.size > 0) {
    const totalRender = [...rendering.values()].reduce((a, b) => a + b.total, 0);
    const rows = [...rendering.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, s]) => [
        name,
        s.count,
        formatMicros(s.avg),
        formatMicros(s.p95),
        formatMicros(s.max),
        formatMicros(s.total),
        formatPercent(s.total, totalRender),
      ]);
    
    renderTable("RENDERING PIPELINE BREAKDOWN", 
      ["Phase", "Count", "Avg", "P95", "Max", "Total", "%"],
      rows);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 3. LONG TASKS (>50ms)
  // ─────────────────────────────────────────────────────────────────────────
  const longTasks = analyzer.parseLongTasks();
  if (longTasks.length > 0) {
    const rows = longTasks.slice(0, 15).map(t => {
      const breakdownStr = [...t.breakdown.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${formatMicros(v)}`)
        .join(", ");
      
      return [
        formatMicros(t.duration),
        t.topFunction?.slice(0, 35) || t.name.slice(0, 35),
        breakdownStr.slice(0, 45),
        t.callStack.length > 1 ? `+${t.callStack.length - 1} more` : "",
      ];
    });
    
    renderTable(`LONG TASKS (>${50}ms) — ${longTasks.length} found`, 
      ["Duration", "Top Function", "Breakdown", "Stack"],
      rows);
    
    // Show call stacks for top 3
    if (longTasks.length > 0) {
      console.log("\n  📍 Top Long Task Call Stacks:");
      for (let i = 0; i < Math.min(3, longTasks.length); i++) {
        const t = longTasks[i];
        if (t.callStack.length > 0) {
          console.log(`     ${i + 1}. ${formatMicros(t.duration)} task:`);
          for (const fn of t.callStack.slice(0, 4)) {
            console.log(`        → ${fn.slice(0, 70)}`);
          }
        }
      }
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 4. JAVASCRIPT FUNCTION PROFILING
  // ─────────────────────────────────────────────────────────────────────────
  const jsProfile = analyzer.parseJSProfile();
  if (jsProfile.length > 0) {
    const totalJS = jsProfile.reduce((a, b) => a + b.totalTime, 0);
    const rows = jsProfile.slice(0, 25).map(f => [
      f.name.slice(0, 50),
      f.hitCount,
      formatMicros(f.totalTime / f.hitCount),
      formatMicros(f.totalTime),
      formatPercent(f.totalTime, totalJS),
    ]);
    
    renderTable("JAVASCRIPT FUNCTION HOTSPOTS (FunctionCall Events)", 
      ["Function", "Calls", "Avg", "Total", "%"],
      rows);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 4b. V8 CPU PROFILE (detailed sampling)
  // ─────────────────────────────────────────────────────────────────────────
  const v8Profile = analyzer.parseV8CpuProfile();
  if (v8Profile.functions.length > 0) {
    const totalSelfTime = v8Profile.functions.reduce((a, b) => a + b.selfTime, 0);
    const rows = v8Profile.functions.slice(0, 30).map(f => [
      f.name.slice(0, 55),
      f.hitCount,
      formatMicros(f.selfTime),
      formatPercent(f.selfTime, totalSelfTime),
    ]);
    
    renderTable(`V8 CPU PROFILE — Self Time (${v8Profile.totalSamples.toLocaleString()} samples)`, 
      ["Function", "Samples", "Self Time", "%"],
      rows);
  } else {
    console.log("\n  ℹ️  V8 CPU Profile not found. Enable 'disabled-by-default-v8.cpu_profiler' category for detailed sampling.\n");
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 5. EVENT HANDLERS
  // ─────────────────────────────────────────────────────────────────────────
  const handlers = analyzer.parseEventHandlers();
  if (handlers.length > 0) {
    // Group by event type
    const byType = new Map<string, { count: number; total: number; max: number }>();
    for (const h of handlers) {
      const existing = byType.get(h.type) || { count: 0, total: 0, max: 0 };
      existing.count++;
      existing.total += h.duration;
      existing.max = Math.max(existing.max, h.duration);
      byType.set(h.type, existing);
    }
    
    const rows = [...byType.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15)
      .map(([type, s]) => [
        type,
        s.count,
        formatMicros(s.total / s.count),
        formatMicros(s.max),
        formatMicros(s.total),
      ]);
    
    renderTable("EVENT HANDLER TIMING", 
      ["Event Type", "Count", "Avg", "Max", "Total"],
      rows);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 6. FORCED REFLOWS
  // ─────────────────────────────────────────────────────────────────────────
  const reflows = analyzer.parseForcedReflows();
  if (reflows.count > 0) {
    const rows = reflows.examples.slice(0, 10).map(r => [
      formatMicros(r.duration),
      r.stack?.slice(0, 60) || "(no stack)",
    ]);
    
    renderTable(`FORCED REFLOWS (Layout Thrashing) — ${reflows.count} found`, 
      ["Duration", "Trigger Location"],
      rows);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 7. GC ACTIVITY
  // ─────────────────────────────────────────────────────────────────────────
  const gc = analyzer.parseGC();
  if (gc.count > 0) {
    // Group by GC type
    const byType = new Map<string, { count: number; total: number }>();
    for (const g of gc.events) {
      const existing = byType.get(g.type) || { count: 0, total: 0 };
      existing.count++;
      existing.total += g.duration;
      byType.set(g.type, existing);
    }
    
    const rows = [...byType.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([type, s]) => [
        type,
        s.count,
        formatMicros(s.total / s.count),
        formatMicros(s.total),
      ]);
    
    renderTable("GARBAGE COLLECTION", 
      ["GC Type", "Count", "Avg", "Total"],
      rows);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 8. FRAME TIMING SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  const frames = analyzer.parseFrames();
  if (frames.length > 0) {
    const durations = frames.map(f => f.duration);
    const sorted = [...durations].sort((a, b) => a - b);
    const fps = 1_000_000 / (sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    
    const jankFrames = frames.filter(f => f.duration > 16_667); // >16.67ms = <60fps
    const longFrames = frames.filter(f => f.duration > 33_333); // >33.33ms = <30fps
    
    renderSummaryBox("FRAME TIMING ANALYSIS", [
      ["Total Frames", frames.length.toString()],
      ["Avg FPS", fps.toFixed(1)],
      ["P50 Frame Time", formatMicros(p50)],
      ["P95 Frame Time", formatMicros(p95)],
      ["P99 Frame Time", formatMicros(p99)],
      ["Jank Frames (>16.67ms)", `${jankFrames.length} (${formatPercent(jankFrames.length, frames.length)})`],
      ["Slow Frames (>33.33ms)", `${longFrames.length} (${formatPercent(longFrames.length, frames.length)})`],
    ]);
    
    // Show worst frames breakdown
    const worstFrames = [...frames].sort((a, b) => b.duration - a.duration).slice(0, 5);
    if (worstFrames.length > 0 && worstFrames[0].duration > 16_667) {
      const rows = worstFrames.map(f => [
        formatMicros(f.duration),
        formatMicros(f.scriptTime),
        formatMicros(f.layoutTime),
        formatMicros(f.styleTime),
        formatMicros(f.paintTime),
        formatMicros(f.idleTime),
      ]);
      
      renderTable("WORST FRAMES BREAKDOWN", 
        ["Total", "Script", "Layout", "Style", "Paint", "Idle"],
        rows);
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // 9. OVERALL SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  const totalUserTiming = [...userTiming.values()].reduce((a, b) => a + b.total, 0);
  const totalRendering = [...rendering.values()].reduce((a, b) => a + b.total, 0);
  const totalJS = jsProfile.reduce((a, b) => a + b.totalTime, 0);
  
  renderSummaryBox("TIMING SUMMARY", [
    ["User Timing Total", formatMicros(totalUserTiming)],
    ["Rendering Total", formatMicros(totalRendering)],
    ["JS Execution Total", formatMicros(totalJS)],
    ["Long Tasks", longTasks.length.toString()],
    ["Forced Reflows", reflows.count.toString()],
    ["GC Events", `${gc.count} (${formatMicros(gc.totalTime)})`],
  ]);
  
  console.log("\n" + "═".repeat(80) + "\n");
}

// ════════════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const traceFile = args[0] || "benchmark-trace.json";

try {
  console.log(`\n📁 Parsing: ${traceFile}`);
  const start = performance.now();
  
  const content = readFileSync(traceFile, "utf-8");
  const trace = JSON.parse(content);
  const events: TraceEvent[] = trace.traceEvents || trace;
  
  console.log(`   Found ${events.length.toLocaleString()} trace events`);
  
  const analyzer = new TraceAnalyzer(events);
  generateReport(analyzer);
  
  const elapsed = performance.now() - start;
  console.log(`⏱️  Analysis completed in ${elapsed.toFixed(0)}ms\n`);
  
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") {
    console.error(`❌ File not found: ${traceFile}`);
    console.error("Run 'bun run benchmark' first to generate a trace.");
  } else {
    console.error(`❌ Error:`, (e as Error).message);
  }
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════════
// STANDALONE CPU PROFILE PARSING
// ════════════════════════════════════════════════════════════════════════════

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
  positionTicks?: { line: number; ticks: number }[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

function parseCpuProfile(profile: CpuProfile): void {
  console.log("\n" + "═".repeat(80));
  console.log("                    V8 CPU PROFILE ANALYSIS");
  console.log("═".repeat(80));
  
  const nodeMap = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }
  
  // Calculate self-time from samples + timeDeltas
  const selfTimes = new Map<number, number>();
  const sampleCounts = new Map<number, number>();
  
  for (let i = 0; i < profile.samples.length; i++) {
    const nodeId = profile.samples[i];
    const delta = profile.timeDeltas[i] || 0;
    selfTimes.set(nodeId, (selfTimes.get(nodeId) || 0) + delta);
    sampleCounts.set(nodeId, (sampleCounts.get(nodeId) || 0) + 1);
  }
  
  // Aggregate by function
  const functionStats = new Map<string, { selfTime: number; samples: number; url: string; line?: number }>();
  
  for (const [nodeId, selfTime] of selfTimes) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    
    const cf = node.callFrame;
    // Skip synthetic nodes
    if (cf.functionName.startsWith("(") && cf.functionName.endsWith(")")) continue;
    if (!cf.functionName) continue;
    
    const file = cf.url.split("/").pop()?.split("?")[0] || "";
    const loc = cf.lineNumber >= 0 ? `:${cf.lineNumber + 1}` : "";
    const displayName = file ? `${cf.functionName} (${file}${loc})` : cf.functionName;
    
    const existing = functionStats.get(displayName) || { selfTime: 0, samples: 0, url: cf.url, line: cf.lineNumber };
    existing.selfTime += selfTime;
    existing.samples += sampleCounts.get(nodeId) || 0;
    functionStats.set(displayName, existing);
  }
  
  // Sort and display
  const sorted = [...functionStats.entries()]
    .sort((a, b) => b[1].selfTime - a[1].selfTime);
  
  const totalSelfTime = sorted.reduce((a, [, b]) => a + b.selfTime, 0);
  const totalSamples = profile.samples.length;
  const duration = profile.endTime - profile.startTime;
  
  console.log(`\n  📊 Profile Summary:`);
  console.log(`     Total samples: ${totalSamples.toLocaleString()}`);
  console.log(`     Duration: ${formatMicros(duration)}`);
  console.log(`     Sample rate: ~${(totalSamples / (duration / 1_000_000)).toFixed(0)} samples/sec`);
  
  const rows = sorted.slice(0, 35).map(([name, data]) => [
    name.slice(0, 60),
    data.samples,
    formatMicros(data.selfTime),
    formatPercent(data.selfTime, totalSelfTime),
  ]);
  
  renderTable("TOP FUNCTIONS BY SELF TIME", 
    ["Function", "Samples", "Self Time", "%"],
    rows);
  
  console.log("\n" + "═".repeat(80) + "\n");
}

// Try to load CPU profile if it exists
try {
  const cpuProfilePath = traceFile.replace(/trace\.json$/, "cpuprofile.json").replace("benchmark-trace", "benchmark-cpuprofile");
  const cpuContent = readFileSync(cpuProfilePath, "utf-8");
  const cpuProfile: CpuProfile = JSON.parse(cpuContent);
  
  if (cpuProfile.nodes && cpuProfile.samples) {
    parseCpuProfile(cpuProfile);
  }
} catch {
  // CPU profile not found, that's OK
}
