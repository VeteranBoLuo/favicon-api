import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ServiceError } from "../src/error.js";
import { fetchHedged, getCacheStats, getFavicon } from "../src/favicon.js";

const IMAGE_RESULT = {
  buffer: Buffer.alloc(64, 1),
  contentType: "image/png",
  finalUrl: "https://example.test/favicon.ico",
  sourceType: "favicon",
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createOptions(overrides = {}) {
  return {
    validateOrigin: async () => {},
    totalTimeoutMs: 200,
    firstHedgeMs: 0,
    secondHedgeMs: 0,
    fetchRoot: async () => {
      throw new ServiceError("ICON_NOT_FOUND");
    },
    fetchDeclared: async () => {
      throw new ServiceError("ICON_NOT_FOUND");
    },
    fetchAggregator: async () => {
      throw new ServiceError("ICON_NOT_FOUND");
    },
    ...overrides,
  };
}

describe("hedged favicon fetch", () => {
  it("passes AbortSignal to every concurrent source", async () => {
    const signals = [];
    const recordSignal = async ({ signal }) => {
      signals.push(signal);
      throw new ServiceError("ICON_NOT_FOUND");
    };

    await assert.rejects(
      () => fetchHedged(
        "https://example.test/",
        "example.test",
        createOptions({
          fetchRoot: recordSignal,
          fetchDeclared: recordSignal,
          fetchAggregator: recordSignal,
        }),
      ),
      { code: "ICON_NOT_FOUND" },
    );

    assert.equal(signals.length, 4);
    for (const signal of signals) {
      assert.equal(typeof signal?.addEventListener, "function");
      assert.equal(typeof signal?.aborted, "boolean");
    }
  });

  it("starts root favicon and HTML-declared attempts concurrently", async () => {
    const rootGate = createDeferred();
    const started = [];

    const resultPromise = fetchHedged(
      "https://example.test/",
      "example.test",
      createOptions({
        firstHedgeMs: 100,
        secondHedgeMs: 120,
        fetchRoot: async () => {
          started.push("root");
          return rootGate.promise;
        },
        fetchDeclared: async () => {
          started.push("declared");
          return IMAGE_RESULT;
        },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(started, ["root", "declared"]);

    const result = await resultPromise;
    assert.equal(result.buffer, IMAGE_RESULT.buffer);
  });

  it("does not let a rejected aggregator beat a later valid icon", async () => {
    const result = await fetchHedged(
      "https://example.test/",
      "example.test",
      createOptions({
        fetchRoot: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return IMAGE_RESULT;
        },
        fetchAggregator: async () => {
          throw new ServiceError("UPSTREAM_ERROR");
        },
      }),
    );

    assert.equal(result.buffer, IMAGE_RESULT.buffer);
  });

  it("aborts remaining sources after the first valid icon wins", async () => {
    let observedAbort = false;

    const result = await fetchHedged(
      "https://example.test/",
      "example.test",
      createOptions({
        fetchRoot: async () => IMAGE_RESULT,
        fetchDeclared: ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          }, { once: true });
        }),
      }),
    );

    assert.equal(result.buffer, IMAGE_RESULT.buffer);
    await Promise.resolve();
    assert.equal(observedAbort, true);
  });

  it("returns ICON_NOT_FOUND only when every source explicitly has no icon", async () => {
    await assert.rejects(
      () => fetchHedged(
        "https://example.test/",
        "example.test",
        createOptions(),
      ),
      { code: "ICON_NOT_FOUND" },
    );
  });

  it("classifies unexpected source failures as INTERNAL_ERROR", async () => {
    await assert.rejects(
      () => fetchHedged(
        "https://example.test/",
        "example.test",
        createOptions({
          fetchRoot: async () => {
            throw new TypeError("unexpected implementation failure");
          },
        }),
      ),
      { code: "INTERNAL_ERROR" },
    );
  });

  it("stays within the per-request total timeout budget", async () => {
    const startedAt = Date.now();

    await assert.rejects(
      () => fetchHedged(
        "https://example.test/",
        "example.test",
        createOptions({
          totalTimeoutMs: 40,
          firstHedgeMs: 100,
          secondHedgeMs: 120,
          fetchRoot: ({ signal }) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
          fetchDeclared: ({ signal }) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        }),
      ),
      { code: "UPSTREAM_TIMEOUT" },
    );

    assert.ok(Date.now() - startedAt < 150);
  });
});

it("clears inFlight after the limiter rejects a full queue", async () => {
  const rejectingLimiter = {
    acquire: async () => {
      throw new ServiceError("QUEUE_FULL");
    },
  };

  await assert.rejects(
    () => getFavicon("https://queue-full-cleanup.example", {
      limiter: rejectingLimiter,
    }),
    { code: "QUEUE_FULL" },
  );

  assert.equal(getCacheStats().inFlight, 0);
});
