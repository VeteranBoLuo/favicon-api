/**
 * 结构化错误类型
 *
 * 为 favicon-api 提供统一的 ServiceError 类、预定义错误码和 HTTP 映射。
 */

/** 预定义错误码及其语义 */
export const ERROR_CODES = {
  INVALID_URL: { http: 400, retryable: false, message: "Invalid URL" },
  PRIVATE_ADDRESS: { http: 403, retryable: false, message: "Private and reserved addresses are not allowed" },
  DNS_ERROR: { http: 502, retryable: true, message: "Unable to resolve hostname" },
  ICON_NOT_FOUND: { http: 404, retryable: false, message: "No favicon found" },
  UPSTREAM_TIMEOUT: { http: 504, retryable: true, message: "Favicon request timed out" },
  UPSTREAM_ERROR: { http: 502, retryable: true, message: "Upstream server error" },
  QUEUE_FULL: { http: 503, retryable: true, message: "Favicon service is busy" },
  INTERNAL_ERROR: { http: 500, retryable: true, message: "Internal server error" },
};

export class ServiceError extends Error {
  /**
   * @param {string} code  - 错误码，必须是 ERROR_CODES 的键
   * @param {string} [message] - 覆盖默认消息
   */
  constructor(code, message) {
    const def = ERROR_CODES[code];
    if (!def) {
      super(message || "Unknown error");
      this.name = "ServiceError";
      this.code = "INTERNAL_ERROR";
      this.httpStatus = 500;
      this.retryable = true;
      return;
    }
    super(message || def.message);
    this.name = "ServiceError";
    this.code = code;
    this.httpStatus = def.http;
    this.retryable = def.retryable;
  }

  toJSON() {
    return {
      code: this.code,
      retryable: this.retryable,
      error: this.message,
    };
  }
}

/**
 * 根据 HTTP 状态码和已有错误信息猜测错误码
 * 用于安全还原第三方源的异常
 */
export function classifyError(err) {
  if (err instanceof ServiceError) return err;

  const message = String(err?.message || err?.code || "");

  if (err?.code === "ABORT_ERR" || err?.name === "TimeoutError" || message.includes("timed out") || message.includes("timeout") || message.includes("abort")) {
    return new ServiceError("UPSTREAM_TIMEOUT");
  }
  if (message.includes("Invalid URL") || message.includes("INVALID_URL")) {
    return new ServiceError("INVALID_URL");
  }
  if (message.includes("PRIVATE_ADDRESS") || message.includes("private") || message.includes("reserved")) {
    return new ServiceError("PRIVATE_ADDRESS");
  }
  if (message.includes("DNS") || message.includes("EAI_AGAIN") || message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
    return new ServiceError("DNS_ERROR");
  }
  if (message.includes("not found") || message.includes("404") || message.includes("ICON_NOT_FOUND") || message.includes("No favicon")) {
    return new ServiceError("ICON_NOT_FOUND");
  }
  if (message.includes("502") || message.includes("bad gateway") || message.includes("upstream") || message.includes("ETIMEDOUT") || message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return new ServiceError("UPSTREAM_ERROR");
  }
  return new ServiceError("INTERNAL_ERROR", message);
}
