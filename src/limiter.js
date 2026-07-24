/**
 * 全局并发限制器和等待队列
 *
 * 允许多少个 Origin 同时进行 favicon 抓取。
 * 当队列满时，返回 QUEUE_FULL 错误。
 *
 * 槽位交接采用直接转交模式：release 时如果队列有任务，
 * 直接将当前槽位转交给下一个，避免 active-- 和下一个
 * active++ 之间的竞态窗口。
 */

import { ServiceError } from "./error.js";

const DEFAULT_CONCURRENCY = Math.max(
  1,
  Number.parseInt(
    process.env.FAVICON_FETCH_CONCURRENCY || '12',
    10,
  ),
);

const DEFAULT_QUEUE_MAX = Math.max(
  0,
  Number.parseInt(
    process.env.FAVICON_QUEUE_MAX || '500',
    10,
  ),
);

const DEFAULT_RETRY_AFTER = Math.max(
  1,
  Number.parseInt(
    process.env.FAVICON_QUEUE_RETRY_AFTER_SECONDS || '15',
    10,
  ),
);

export class Limiter {
  #active = 0;
  #queue = [];

  constructor({
    concurrency = DEFAULT_CONCURRENCY,
    queueMax = DEFAULT_QUEUE_MAX,
    retryAfter = DEFAULT_RETRY_AFTER,
  } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.queueMax = Math.max(0, queueMax);
    this.retryAfter = Math.max(1, retryAfter);
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ||
        new DOMException('Aborted', 'AbortError'),
      );
    }

    if (this.#active < this.concurrency) {
      this.#active += 1;
      return Promise.resolve(this.#createRelease());
    }

    if (this.#queue.length >= this.queueMax) {
      return Promise.reject(new ServiceError('QUEUE_FULL'));
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index !== -1) {
          this.#queue.splice(index, 1);
        }
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  #createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.#queue.length) {
        const next = this.#queue.shift();
        next.signal?.removeEventListener('abort', next.onAbort);
        if (next.signal?.aborted) continue;
        // 槽位直接交给下一个任务，active 保持不变
        next.resolve(this.#createRelease());
        return;
      }

      this.#active = Math.max(0, this.#active - 1);
    };
  }

  get active() { return this.#active; }
  get queued() { return this.#queue.length; }
}

export const limiter = new Limiter();
