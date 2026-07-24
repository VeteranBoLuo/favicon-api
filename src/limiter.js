/**
 * 全局并发限制器和等待队列
 *
 * 允许多少个 Origin 同时进行 favicon 抓取。
 * 当队列满时，返回 QUEUE_FULL 错误。
 */

import { ServiceError } from "./error.js";

// 环境变量默认值
const CONCURRENCY = parseInt(process.env.FAVICON_FETCH_CONCURRENCY || "8", 10);
const QUEUE_MAX = parseInt(process.env.FAVICON_QUEUE_MAX || "500", 10);
const RETRY_AFTER_SECONDS = parseInt(process.env.FAVICON_QUEUE_RETRY_AFTER_SECONDS || "15", 10);

/** 全局限制器实例 */
class Limiter {
  #active = 0;
  #queue = [];
  #concurrency;
  #queueMax;
  #retryAfter;

  constructor({ concurrency = CONCURRENCY, queueMax = QUEUE_MAX, retryAfter = RETRY_AFTER_SECONDS } = {}) {
    this.#concurrency = Math.max(1, concurrency);
    this.#queueMax = Math.max(0, queueMax);
    this.#retryAfter = Math.max(0, retryAfter);
  }

  get active() {
    return this.#active;
  }

  get queued() {
    return this.#queue.length;
  }

  get concurrency() {
    return this.#concurrency;
  }

  /**
   * 尝试获取执行许可。
   * 如果当前活跃数未达上限，立即返回一个释放函数。
   * 否则将任务加入队列；如果队列已满则抛出 QUEUE_FULL。
   *
   * @returns {Function} release - 调用以释放并发槽位
   */
  async acquire() {
    if (this.#active < this.#concurrency) {
      this.#active++;
      return this.#release();
    }

    if (this.#queue.length >= this.#queueMax) {
      const err = new ServiceError("QUEUE_FULL");
      err.retryAfter = this.#retryAfter;
      throw err;
    }

    // 加入队列等待
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.#queue.push(entry);
    }).then(() => {
      this.#active++;
      return this.#release();
    });
  }

  #release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      // 从队列取出下一个等待任务
      if (this.#queue.length > 0) {
        const entry = this.#queue.shift();
        entry.resolve(); // 触发下一个 acquire 返回
      }
    };
  }

  /**
   * 取消一个尚未开始的队列请求
   * 返回 true 表示成功从队列移除
   */
  cancel(promise) {
    const idx = this.#queue.findIndex((e) => e.promise === promise);
    if (idx !== -1) {
      this.#queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  get retryAfter() {
    return this.#retryAfter;
  }
}

export const limiter = new Limiter();
export { Limiter as LimiterClass };
