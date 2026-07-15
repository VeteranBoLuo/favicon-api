import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createUsageCounter } from "../src/usage-counter.js";

test("usage counter persists successful request totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "favicon-usage-"));
  const filePath = join(directory, "count.json");

  try {
    const counter = createUsageCounter({ filePath, initialCount: "12000" });
    assert.equal(await counter.value(), 12000);
    assert.equal(await counter.increment(), 12001);
    await counter.flush();
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { count: 12001 });

    const restored = createUsageCounter({ filePath });
    assert.equal(await restored.value(), 12001);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
