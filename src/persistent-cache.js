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

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = process.env.FAVICON_CACHE_DIR || "./data/cache";
const PERSISTENT_CACHE_TTL_MS = parseInt(
  process.env.FAVICON_PERSISTENT_CACHE_TTL_MS || "604800000",
  10,
); // 7 天
const PERSISTENT_CACHE_MAX = parseInt(
  process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES || "5000",
  10,
);
const PERSISTENT_CACHE_ENABLED =
  process.env.FAVICON_PERSISTENT_CACHE_TTL_MS !== undefined
    ? true
    : process.env.FAVICON_CACHE_DIR !== undefined;

// 清理计数器：每 N 次写入触发一次清理
let cleanupCounter = 0;
const operationQueues = new Map();

function enqueueCacheOperation(keyHash, operation) {
  const previousOperation = operationQueues.get(keyHash) || Promise.resolve();
  const task = previousOperation.catch(() => {}).then(operation);
  operationQueues.set(keyHash, task);
  task.finally(() => {
    if (operationQueues.get(keyHash) === task) operationQueues.delete(keyHash);
  });
  return task;
}

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
      deleteExpiredOrCorruptEntry(keyHash).catch(() => {});
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
  if (!PERSISTENT_CACHE_ENABLED) return Promise.resolve();

  const keyHash = sha256Hex(originKey);
  const dir = join(CACHE_DIR, keyHash);

  const metadata = {
    origin: originKey,
    contentType: result.contentType,
    sourceType: result.sourceType || "favicon",
    createdAt: Date.now(),
    expiresAt: Date.now() + PERSISTENT_CACHE_TTL_MS,
  };

  const writeTask = enqueueCacheOperation(keyHash, async () => {
    const writeId = `${process.pid}-${randomUUID()}`;
    const tempIcon = join(dir, `.icon-${writeId}.tmp`);
    const tempMeta = join(dir, `.meta-${writeId}.tmp`);
    try {
      await mkdir(dir, { recursive: true });

      // 写图标文件（临时 + rename）
      await writeFile(tempIcon, result.buffer);
      await rename(tempIcon, join(dir, "icon.bin"));

      // 写元数据
      await writeFile(tempMeta, JSON.stringify(metadata, null, 2));
      await rename(tempMeta, join(dir, "metadata.json"));
    } catch (err) {
      // 持久缓存写入失败不影响主流程
      await Promise.all([
        rm(tempIcon, { force: true }).catch(() => {}),
        rm(tempMeta, { force: true }).catch(() => {}),
      ]);
      console.warn(
        `[persistent-cache] write failed code=${err?.code || "UNKNOWN"}`,
      );
    }
  });

  // 定期清理
  cleanupCounter++;
  if (cleanupCounter % 50 === 0) {
    scheduleCleanup().catch(() => {});
  }

  return writeTask;
}

/**
 * 删除持久缓存条目
 */
export async function deletePersistentCache(originKey) {
  if (!PERSISTENT_CACHE_ENABLED) return;
  const keyHash = sha256Hex(originKey);
  await enqueueCacheOperation(keyHash, () =>
    tryHardDelete(join(CACHE_DIR, keyHash)),
  );
}

/**
 * 清理过期条目（小批次，不阻塞）
 */
export async function scheduleCleanup() {
  if (!PERSISTENT_CACHE_ENABLED) return;
  try {
    const entries = await readdir(CACHE_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    const now = Date.now();
    let removed = 0;
    const validEntries = [];
    for (const dir of dirs) {
      if (removed >= 100) break;
      const metadata = await readCacheMetadata(dir.name);
      if (!metadata || now > Number(metadata.expiresAt || 0)) {
        if (await deleteExpiredOrCorruptEntry(dir.name, now)) removed++;
        continue;
      }
      validEntries.push({
        keyHash: dir.name,
        createdAt: Number(metadata.createdAt || 0),
      });
    }

    // TTL 尚未到期也必须受最大条目数约束；按创建时间淘汰最旧项。
    const overflow = Math.max(validEntries.length - PERSISTENT_CACHE_MAX, 0);
    if (overflow > 0 && removed < 100) {
      const oldestEntries = validEntries
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, Math.min(overflow, 100 - removed));
      for (const entry of oldestEntries) {
        if (await deleteEntryIfUnchanged(entry.keyHash, entry.createdAt))
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

async function readCacheMetadata(keyHash) {
  try {
    const raw = await readFile(
      join(CACHE_DIR, keyHash, "metadata.json"),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deleteExpiredOrCorruptEntry(keyHash, now = Date.now()) {
  return enqueueCacheOperation(keyHash, async () => {
    const dir = join(CACHE_DIR, keyHash);
    try {
      const raw = await readFile(join(dir, "metadata.json"), "utf8");
      const metadata = JSON.parse(raw);
      if (now <= metadata.expiresAt) return false;
    } catch {
      // 当前 Origin 的写操作与清理在同一队列中；此时缺少 metadata 才表示损坏。
    }
    await tryHardDelete(dir);
    return true;
  });
}

async function deleteEntryIfUnchanged(keyHash, expectedCreatedAt) {
  return enqueueCacheOperation(keyHash, async () => {
    const dir = join(CACHE_DIR, keyHash);
    const metadata = await readCacheMetadata(keyHash);
    if (!metadata || Number(metadata.createdAt || 0) !== expectedCreatedAt)
      return false;
    await tryHardDelete(dir);
    return true;
  });
}

async function tryHardDelete(dirPath) {
  await rm(dirPath, { recursive: true, force: true });
}
