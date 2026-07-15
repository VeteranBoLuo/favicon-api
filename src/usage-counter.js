import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function parseCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function createUsageCounter({
  filePath = process.env.FAVICON_USAGE_COUNT_FILE,
  initialCount = process.env.FAVICON_USAGE_COUNT_START,
} = {}) {
  let count = parseCount(initialCount);
  let pendingWrite = Promise.resolve();
  let persistenceWarningShown = false;

  const ready = (async () => {
    if (!filePath) return;

    try {
      const stored = JSON.parse(await readFile(filePath, "utf8"));
      count = Math.max(count, parseCount(stored.count));
    } catch (error) {
      if (error.code !== "ENOENT") warnOnce(error);
    }
  })();

  function warnOnce(error) {
    if (persistenceWarningShown) return;
    persistenceWarningShown = true;
    console.warn(`Unable to persist favicon usage count: ${error.message}`);
  }

  function persist() {
    if (!filePath) return;
    const snapshot = count;

    pendingWrite = pendingWrite
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify({ count: snapshot })}\n`);
        await rename(temporaryPath, filePath);
      })
      .catch(warnOnce);
  }

  return {
    async value() {
      await ready;
      return count;
    },

    async increment() {
      await ready;
      count += 1;
      persist();
      return count;
    },

    async flush() {
      await ready;
      await pendingWrite;
    },
  };
}

export const usageCounter = createUsageCounter();
