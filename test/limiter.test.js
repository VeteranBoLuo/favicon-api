import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { LimiterClass } from "../src/limiter.js";

describe("Limiter concurrency control", () => {
  it("acquire returns immediately when under concurrency limit", async () => {
    const limiter = new LimiterClass({ concurrency: 5, queueMax: 10 });
    const release = await limiter.acquire();
    assert.equal(typeof release, "function");
    assert.equal(limiter.active, 1);
    release();
    assert.equal(limiter.active, 0);
  });

  it("queues tasks when at concurrency limit", async () => {
    const limiter = new LimiterClass({ concurrency: 2, queueMax: 10 });
    const releases = await Promise.all([limiter.acquire(), limiter.acquire()]);
    assert.equal(limiter.active, 2);
    assert.equal(limiter.queued, 0);

    // 第三个请求应该排队
    const thirdPromise = limiter.acquire();
    assert.equal(limiter.queued, 1);

    // 释放一个槽位后，第三个应该执行
    releases[0]();
    // 等微任务执行
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(limiter.active, 2);
    assert.equal(limiter.queued, 0);

    const release3 = await thirdPromise;
    release3();
    releases[1]();
  });

  it("throws QUEUE_FULL when queue is full", async () => {
    const limiter = new LimiterClass({ concurrency: 1, queueMax: 2 });
    await limiter.acquire(); // 占用唯一槽位

    // 填满队列
    const q1 = limiter.acquire();
    const q2 = limiter.acquire();

    // 第 3 个应抛 QUEUE_FULL
    await assert.rejects(
      () => limiter.acquire(),
      (err) => err.code === "QUEUE_FULL",
    );
  });

  it("FIFO order: first queued is first served", async () => {
    const limiter = new LimiterClass({ concurrency: 1, queueMax: 10 });
    const keep = await limiter.acquire();

    const order = [];
    const t1 = limiter.acquire().then((r) => { order.push(1); return r; });
    const t2 = limiter.acquire().then((r) => { order.push(2); return r; });
    assert.equal(limiter.queued, 2);

    // 释放槽位，等微任务执行
    keep();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(order.length, 1);
    assert.equal(order[0], 1, "first queued should be served first");
    assert.equal(limiter.queued, 1);

    // 清理
    const r1 = await t1;
    r1();
    const r2 = await t2;
    r2();
  });

  it("retryAfter reflects the configured value", () => {
    const limiter = new LimiterClass({ retryAfter: 15 });
    assert.equal(limiter.retryAfter, 15);
  });
});
