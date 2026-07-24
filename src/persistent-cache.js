/**
 * 持久缓存（文件系统）
 *
 * 在内存成功缓存的基础上增加文件系统层。
 * 进程重启后从磁盘恢复缓存，避免冷启动重新抓取所有图标。
 *
 * 目录结构：
 *   {cacheDir}/{originSha256}/
 *     icon.bin          — 图标原始二进制
 *     metadata.json     — 来源类型、Content-Type、创建时间、过期时间
 *
 * 写策略：先写临时文件，再原子 rename，不阻塞请求主链。
 * 清理：达到最大条目数时小批次清理最早过期的条目。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const CACHE_DIR = process.env.FAVICON_CACHE_DIR || "./data/cache";
const PERSISTENT_CACHE_TTL_MS = parseInt(process.env.FAVICON_PERSISTENT_CACHE_TTL_MS || "604800000", 10); // 7 天
const PERSISTENT_CACHE_MAX = parseInt(process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES || "5000", 10);
const PERSISTENT_CACHE_ENABLED = process.env.FAVICON_PERSISTENT_CACHE_TTL_MS !== undefined
  ? true
  : process.env.FAVICON_CACHE_DIR !== undefined;

// 清理计数器：每 N 次写入触发一次清理
let cleanupCounter = 0;

/**
 * 从持久缓存读取
 * @param {string} originKey - "https://github.com"
 * @returns {Promise<{buffer:Buffer, contentType:string, sourceType:string, createdAt:number}|null>}
 */
export async function readPersistentCache(originKey) {
  if (!PERSISTENT_CACHE_ENABLED) return null;
  try {
    const keyHash = sha256Hex(originKey);
    const metadataPath = join(CACHE_DIR, keyHash, "metadata.json");
    const iconPath = join(CACHE_DIR, keyHash, "icon.bin");

    const metadataRaw = await readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataRaw);

    // 检查过期
    if (Date.now() > metadata.expiresAt) {
      // 静默清理过期条目，不阻塞
      tryHardDelete(join(CACHE_DIR, keyHash)).catch(() => {});
      return null;
    }

    const buffer = await readFile(iconPath);
    return {
      buffer,
      contentType: metadata.contentType,
      sourceType: metadata.sourceType || "cache",
      createdAt: metadata.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * 写入持久缓存（异步，不等待）
 * @param {string} originKey
 * @param {{buffer:Buffer, contentType:string, sourceType:string}} result
 */
export function writePersistentCache(originKey, result) {
  if (!PERSISTENT_CACHE_ENABLED) return;

  const keyHash = sha256Hex(originKey);
  const dir = join(CACHE_DIR, keyHash);

  const metadata = {
    origin: originKey,
    contentType: result.contentType,
    sourceType: result.sourceType || "favicon",
    createdAt: Date.now(),
    expiresAt: Date.now() + PERSISTENT_CACHE_TTL_MS,
  };

  // 异步写入，不阻塞主链
  (async () => {
    try {
      await mkdir(dir, { recursive: true });

      // 写图标文件（临时 + rename）
      const tempIcon = join(dir, `.icon-${process.pid}.tmp`);
      await writeFile(tempIcon, result.buffer);
      await rename(tempIcon, join(dir, "icon.bin"));

      // 写元数据
      const tempMeta = join(dir, `.meta-${process.pid}.tmp`);
      await writeFile(tempMeta, JSON.stringify(metadata, null, 2));
      await rename(tempMeta, join(dir, "metadata.json"));
    } catch (err) {
      // 持久缓存写入失败不影响主流程
      console.warn(`[persistent-cache] write failed for ${originKey}: ${err.message}`);
    }
  })();

  // 定期清理
  cleanupCounter++;
  if (cleanupCounter % 50 === 0) {
    scheduleCleanup().catch(() => {});
  }
}

/**
 * 删除持久缓存条目
 */
export async function deletePersistentCache(originKey) {
  if (!PERSISTENT_CACHE_ENABLED) return;
  const keyHash = sha256Hex(originKey);
  await tryHardDelete(join(CACHE_DIR, keyHash));
}

/**
 * 清理过期条目（小批次，不阻塞）
 */
export async function scheduleCleanup() {
  if (!PERSISTENT_CACHE_ENABLED) return;
  try {
    const entries = await readdir(CACHE_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    // 排序：按目录名（即 hash）顺序，清理最早一批
    const now = Date.now();
    let removed = 0;
    for (const dir of dirs) {
      if (removed >= 100) break; // 每轮最多清 100
      try {
        const metaPath = join(CACHE_DIR, dir.name, "metadata.json");
        const raw = await readFile(metaPath, "utf8");
        const meta = JSON.parse(raw);
        if (now > meta.expiresAt) {
          await tryHardDelete(join(CACHE_DIR, dir.name));
          removed++;
        }
      } catch {
        // 损坏的条目直接删除
        await tryHardDelete(join(CACHE_DIR, dir.name)).catch(() => {});
        removed++;
      }
    }
  } catch {
    // 清理失败忽略（可能是目录不存在）
  }
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

async function tryHardDelete(dirPath) {
  try {
    await unlink(join(dirPath, "icon.bin")).catch(() => {});
    await unlink(join(dirPath, "metadata.json")).catch(() => {});
    await unlink(join(dirPath, ".icon.tmp")).catch(() => {});
    await unlink(join(dirPath, ".meta.tmp")).catch(() => {});
    // rmdir only works on empty dirs; ignore failure if not empty
    await unlink(dirPath).catch(() => {});
  } catch {
    // ignore
  }
}
