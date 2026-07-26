import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

let cacheDir;
let cacheModule;

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "favicon-cache-test-"));
  process.env.FAVICON_CACHE_DIR = cacheDir;
  process.env.FAVICON_PERSISTENT_CACHE_TTL_MS = "60000";
  cacheModule = await import(`../src/persistent-cache.js?test=${Date.now()}`);
});

after(async () => {
  delete process.env.FAVICON_CACHE_DIR;
  delete process.env.FAVICON_PERSISTENT_CACHE_TTL_MS;
  await rm(cacheDir, { recursive: true, force: true });
});

test("deletes an entire persistent cache entry directory", async () => {
  const origin = "https://delete.example";
  await cacheModule.writePersistentCache(origin, {
    buffer: Buffer.alloc(64, 1),
    contentType: "image/png",
    sourceType: "favicon",
  });

  assert.ok(await cacheModule.readPersistentCache(origin));
  await cacheModule.deletePersistentCache(origin);
  assert.equal(await cacheModule.readPersistentCache(origin), null);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("concurrent writes for the same origin do not share temporary names", async () => {
  const origin = "https://concurrent.example";
  const first = Buffer.alloc(64, 2);
  const second = Buffer.alloc(64, 3);

  await Promise.all([
    cacheModule.writePersistentCache(origin, {
      buffer: first,
      contentType: "image/png",
      sourceType: "favicon",
    }),
    cacheModule.writePersistentCache(origin, {
      buffer: second,
      contentType: "image/png",
      sourceType: "declared",
    }),
  ]);

  const cached = await cacheModule.readPersistentCache(origin);
  assert.ok(cached);
  assert.ok(cached.buffer.equals(first) || cached.buffer.equals(second));
  assert.deepEqual(
    (await readdir(cacheDir, { recursive: true })).filter((name) =>
      String(name).endsWith(".tmp"),
    ),
    [],
  );
});

test("cleanup never removes directories that are still being written", async () => {
  const origins = Array.from(
    { length: 60 },
    (_, index) => `https://cleanup-race-${index}.example`,
  );

  await Promise.all([
    ...origins.map((origin, index) =>
      cacheModule.writePersistentCache(origin, {
        buffer: Buffer.alloc(4096, index),
        contentType: "image/png",
        sourceType: "favicon",
      }),
    ),
    ...Array.from({ length: 5 }, () => cacheModule.scheduleCleanup()),
  ]);

  const cached = await Promise.all(
    origins.map((origin) => cacheModule.readPersistentCache(origin)),
  );
  assert.equal(cached.filter(Boolean).length, origins.length);
});

test("cleanup enforces the configured maximum by removing the oldest entries", async () => {
  const boundedCacheDir = await mkdtemp(
    join(tmpdir(), "favicon-cache-max-test-"),
  );
  const previousCacheDir = process.env.FAVICON_CACHE_DIR;
  const previousCacheMax = process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES;
  try {
    process.env.FAVICON_CACHE_DIR = boundedCacheDir;
    process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES = "3";
    const boundedCache = await import(
      `../src/persistent-cache.js?max-test=${Date.now()}`
    );
    const origins = Array.from(
      { length: 5 },
      (_, index) => `https://bounded-${index}.example`,
    );

    for (const [index, origin] of origins.entries()) {
      await boundedCache.writePersistentCache(origin, {
        buffer: Buffer.alloc(64, index + 1),
        contentType: "image/png",
        sourceType: "favicon",
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await boundedCache.scheduleCleanup();

    const cached = await Promise.all(
      origins.map((origin) => boundedCache.readPersistentCache(origin)),
    );
    assert.equal(cached.filter(Boolean).length, 3);
    assert.equal(cached[0], null);
    assert.equal(cached[1], null);
  } finally {
    if (previousCacheDir === undefined) delete process.env.FAVICON_CACHE_DIR;
    else process.env.FAVICON_CACHE_DIR = previousCacheDir;
    if (previousCacheMax === undefined)
      delete process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES;
    else process.env.FAVICON_PERSISTENT_CACHE_MAX_ENTRIES = previousCacheMax;
    await rm(boundedCacheDir, { recursive: true, force: true });
  }
});
