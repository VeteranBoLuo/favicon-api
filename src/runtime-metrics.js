/**
 * 运行时指标
 *
 * 跟踪 favicon-api 运行期间的统计信息，用于 /runtime 接口和内部监控。
 * 所有指标都是无敏感数据的整数计数器。
 */

const metrics = {
  // 请求计数
  totalRequests: 0,
  // 成功来源分布
  directSuccess: 0,
  declaredSuccess: 0,
  faviconIcoSuccess: 0,
  faviconeSuccess: 0,
  yandexSuccess: 0,
  // 错误计数
  timeoutCount: 0,
  queueRejectedCount: 0,
  dnsErrorCount: 0,
  notFoundCount: 0,
  upstreamErrorCount: 0,
  privateAddressCount: 0,
  internalErrorCount: 0,
  // 缓存指标
  deduplicatedCount: 0,
  cacheHitCount: 0,
  cacheMissCount: 0,
  // 延迟追踪（毫秒）
  _durations: [],
};

const MAX_DURATIONS = 1000;

export const runtimeMetrics = {
  increment(counter) {
    if (counter in metrics && typeof metrics[counter] === "number") {
      metrics[counter] += 1;
    }
  },

  recordDuration(ms) {
    metrics._durations.push(ms);
    if (metrics._durations.length > MAX_DURATIONS) {
      metrics._durations.shift();
    }
  },

  /**
   * 返回当前快照（不包含原始延迟数组）
   */
  snapshot() {
    const dur = metrics._durations.slice().sort((a, b) => a - b);
    const len = dur.length;
    return {
      active: 0,              // 由 limiter 更新
      queued: 0,
      inFlightOrigins: 0,
      successCacheEntries: 0,  // 由 favicon.js 更新
      failureCacheEntries: 0,
      totalRequests: metrics.totalRequests,
      successCount:
        metrics.directSuccess +
        metrics.declaredSuccess +
        metrics.faviconIcoSuccess +
        metrics.faviconeSuccess +
        metrics.yandexSuccess,
      timeoutCount: metrics.timeoutCount,
      queueRejectedCount: metrics.queueRejectedCount,
      deduplicatedCount: metrics.deduplicatedCount,
      cacheHitCount: metrics.cacheHitCount,
      cacheMissCount: metrics.cacheMissCount,
      averageDuration: len ? Math.round(dur.reduce((a, b) => a + b, 0) / len) : 0,
      p50Duration: len ? percentile(dur, 50) : 0,
      p95Duration: len ? percentile(dur, 95) : 0,
    };
  },
};

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
