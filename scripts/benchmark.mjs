#!/usr/bin/env node
/**
 * favicon-api 基准测试脚本
 *
 * 用法: node scripts/benchmark.mjs [--output benchmarks/results/file.json] < urls.txt
 *       node scripts/benchmark.mjs --output benchmarks/results/result.json ./benchmark/urls-cold-200.txt
 *
 * 输入: 每行一个公开 URL (严禁使用真实用户书签数据)
 * 输出: JSON 包含 total, success, failed, successRate, durationMs, p50/p90/p95 等
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { handle } from "../src/index.js";

const DEFAULT_PORT = 3987; // 避开 3456(默认运行端口)
const FILTER_CACHE_MISS_HEADER = "x-benchmark-no-cache";

// ── CLI 解析 ──────────────────────────────────────────────
const args = process.argv.slice(2);
let inputFile = null;
let outputFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  } else if (!inputFile) {
    inputFile = args[i];
  }
}

function loadUrls(path) {
  if (!path) {
    // 从 stdin 读取
    const content = readFileSync("/dev/stdin", "utf8");
    return content.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  const content = readFileSync(path, "utf8");
  return content.split("\n").map((l) => l.trim()).filter(Boolean);
}

const urls = loadUrls(inputFile);
if (!urls.length) {
  console.error("没有可测试的 URL，请提供输入文件");
  process.exit(1);
}

// ── 启动临时 HTTP server ──────────────────────────────────
// 支持 FAVICON_API_URL 环境变量指定已有 server（warm test）
const EXTERNAL_URL = process.env.FAVICON_API_URL;
let runningServer = null;

if (EXTERNAL_URL) {
  console.error(`[benchmark] 使用外部 server: ${EXTERNAL_URL}`);
} else {
  runningServer = createServer(handle);
  await new Promise((resolve, reject) => {
    runningServer.listen(DEFAULT_PORT, () => {
      console.error(`[benchmark] 临时 server 运行在 http://127.0.0.1:${DEFAULT_PORT}`);
      resolve();
    });
    runningServer.on("error", reject);
  });
}

function serverUrl(domain) {
  if (EXTERNAL_URL) {
    const base = EXTERNAL_URL.replace(/\/+$/, "");
    return `${base}/?url=${encodeURIComponent(domain)}&preview=1`;
  }
  return `http://127.0.0.1:${DEFAULT_PORT}/?url=${encodeURIComponent(domain)}&preview=1`;
}

// ── 执行测试 ──────────────────────────────────────────────
const results = [];
const errors = {};

console.error(`[benchmark] 开始测试 ${urls.length} 个 URL ...`);

const startOverall = performance.now();

for (let i = 0; i < urls.length; i++) {
  const domain = urls[i];
  const start = performance.now();
  let status = 0;
  let contentType = "";
  let cacheHit = false;
  let sourceUrl = "";
  let errorCode = null;

  try {
    const resp = await fetch(serverUrl(domain), {
      signal: AbortSignal.timeout(30_000),
    });
    status = resp.status;
    contentType = resp.headers.get("content-type") || "";
    cacheHit = resp.headers.get("x-favicon-cache") === "hit";
    sourceUrl = resp.headers.get("x-favicon-source") || resp.headers.get("x-favicon-source-type") || "";

    if (resp.ok) {
      const body = await resp.arrayBuffer();
      results.push({
        domain,
        ok: true,
        duration: Math.round(performance.now() - start),
        status,
        contentType,
        cacheHit,
        sourceUrl: sourceUrl || "unknown",
        errorCode: null,
      });
    } else {
      // 错误响应 (JSON body)
      let errBody = {};
      try {
        errBody = JSON.parse(await resp.text());
      } catch {}
      errorCode = errBody.code || `HTTP_${status}`;
      const cat = errorCode;
      errors[cat] = (errors[cat] || 0) + 1;

      results.push({
        domain,
        ok: false,
        duration: Math.round(performance.now() - start),
        status,
        contentType,
        cacheHit,
        sourceUrl: "",
        errorCode,
      });
    }
  } catch (err) {
    const dur = Math.round(performance.now() - start);
    const cat = err.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "NETWORK_ERROR";
    errors[cat] = (errors[cat] || 0) + 1;

    results.push({
      domain,
      ok: false,
      duration: dur,
      status: 0,
      contentType: "",
      cacheHit: false,
      sourceUrl: "",
      errorCode: cat,
    });
  }

  if ((i + 1) % 50 === 0) {
    console.error(`[benchmark] 已完成 ${i + 1}/${urls.length}`);
  }
}

const totalDuration = Math.round(performance.now() - startOverall);

// ── 关闭 server ──────────────────────────────────────────
if (runningServer) {
  await new Promise((resolve) => runningServer.close(resolve));
}

// ── 统计 ──────────────────────────────────────────────────
const total = results.length;
const successes = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const successRate = total > 0 ? (successes.length / total) * 100 : 0;

const durations = successes.map((r) => r.duration).sort((a, b) => a - b);
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

const p50 = percentile(durations, 50);
const p90 = percentile(durations, 90);
const p95 = percentile(durations, 95);
const max = durations.length ? durations[durations.length - 1] : 0;

const cacheHitCount = successes.filter((r) => r.cacheHit).length;
const cacheMissCount = successes.length - cacheHitCount;

const sourceTypeDist = {};
for (const r of successes) {
  const src = r.sourceUrl || "unknown";
  sourceTypeDist[src] = (sourceTypeDist[src] || 0) + 1;
}

// 运行耗时分布 (全部请求)
const allDurations = results.map((r) => r.duration).sort((a, b) => a - b);
const allP50 = percentile(allDurations, 50);
const allP90 = percentile(allDurations, 90);
const allP95 = percentile(allDurations, 95);

const report = {
  meta: {
    timestamp: new Date().toISOString(),
    totalUrls: urls.length,
    uniqueOrigins: new Set(urls.map((u) => {
      try { return new URL(u.startsWith("http") ? u : `https://${u}`).origin; }
      catch { return u; }
    })).size,
  },
  summary: {
    total,
    success: successes.length,
    failed: failed.length,
    successRate: Math.round(successRate * 100) / 100,
    durationMs: totalDuration,
    requestsPerSecond: total > 0 ? Math.round((total / totalDuration) * 1000 * 100) / 100 : 0,
  },
  latency: {
    p50,
    p90,
    p95,
    max,
    allP50,
    allP90,
    allP95,
  },
  cache: {
    cacheHit: cacheHitCount,
    cacheMiss: cacheMissCount,
    hitRate: successes.length > 0 ? Math.round((cacheHitCount / successes.length) * 10000) / 100 : 0,
  },
  errorCodeDistribution: errors,
  sourceTypeDistribution: sourceTypeDist,
};

// ── 保存 / 输出 ──────────────────────────────────────────
const json = JSON.stringify(report, null, 2);

if (outputFile) {
  const dir = outputFile.substring(0, outputFile.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputFile, json, "utf8");
  console.error(`[benchmark] 结果已保存到 ${outputFile}`);
}

// 同时打印一份人类可读版本到 stderr
console.error("");
console.error("═══════════════════════════════════════════");
console.error("  favicon-api 基准测试报告");
console.error("═══════════════════════════════════════════");
console.error(`  测试时间:        ${report.meta.timestamp}`);
console.error(`  测试 URL 数:     ${report.meta.totalUrls}`);
console.error(`  不同 Origin 数:  ${report.meta.uniqueOrigins}`);
console.error(`  ───────────────────────────────────────`);
console.error(`  总耗时:          ${report.summary.durationMs} ms`);
console.error(`  成功:            ${report.summary.success}`);
console.error(`  失败:            ${report.summary.failed}`);
console.error(`  成功率:          ${report.summary.successRate}%`);
console.error(`  请求/秒:         ${report.summary.requestsPerSecond}`);
console.error(`  ───────────────────────────────────────`);
console.error(`  成功请求延迟 (ms):`);
console.error(`    P50:           ${report.latency.p50}`);
console.error(`    P90:           ${report.latency.p90}`);
console.error(`    P95:           ${report.latency.p95}`);
console.error(`    Max:           ${report.latency.max}`);
console.error(`  ───────────────────────────────────────`);
console.error(`  全部请求延迟 (ms):`);
console.error(`    P50:           ${report.latency.allP50}`);
console.error(`    P90:           ${report.latency.allP90}`);
console.error(`    P95:           ${report.latency.allP95}`);
console.error(`  ───────────────────────────────────────`);
console.error(`  缓存:            ${report.cache.cacheHit} hit / ${report.cache.cacheMiss} miss`);
console.error(`  缓存命中率:      ${report.cache.hitRate}%`);
console.error(`  ───────────────────────────────────────`);
console.error(`  错误分布:`);
for (const [code, count] of Object.entries(report.errorCodeDistribution).sort((a, b) => b[1] - a[1])) {
  console.error(`    ${code}: ${count}`);
}
console.error("═══════════════════════════════════════════");

// stdout 只输出 JSON，方便管道处理
console.log(json);
