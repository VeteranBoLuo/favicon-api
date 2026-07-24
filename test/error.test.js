import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ServiceError, classifyError, ERROR_CODES } from "../src/error.js";

describe("ServiceError", () => {
  it("creates errors with correct code, httpStatus and retryable", () => {
    const err = new ServiceError("DNS_ERROR");
    assert.equal(err.code, "DNS_ERROR");
    assert.equal(err.httpStatus, 502);
    assert.equal(err.retryable, true);
    assert.equal(err.message, "Unable to resolve hostname");
  });

  it("creates non-retryable errors", () => {
    const err = new ServiceError("INVALID_URL");
    assert.equal(err.retryable, false);
    assert.equal(err.httpStatus, 400);
  });

  it("uses custom message when provided", () => {
    const err = new ServiceError("UPSTREAM_TIMEOUT", "Custom timeout message");
    assert.equal(err.message, "Custom timeout message");
  });

  it("falls back to INTERNAL_ERROR for unknown code", () => {
    const err = new ServiceError("UNKNOWN_CODE");
    assert.equal(err.code, "INTERNAL_ERROR");
    assert.equal(err.httpStatus, 500);
  });

  it("toJSON returns structured format", () => {
    const err = new ServiceError("QUEUE_FULL");
    const json = err.toJSON();
    assert.equal(json.code, "QUEUE_FULL");
    assert.equal(json.retryable, true);
    assert.ok(json.error);
  });

  it("all error codes have valid definitions", () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      assert.ok(typeof def.http === "number" && def.http >= 400, `${code} has valid http status`);
      assert.ok(typeof def.retryable === "boolean", `${code} has retryable`);
      assert.ok(typeof def.message === "string" && def.message.length > 0, `${code} has message`);
    }
  });
});

describe("classifyError", () => {
  it("returns ServiceError as-is", () => {
    const se = new ServiceError("DNS_ERROR");
    assert.equal(classifyError(se), se);
  });

  it("classifies abort/timeout errors", () => {
    const err = classifyError(Object.assign(new Error("timed out"), { code: "ABORT_ERR" }));
    assert.equal(err.code, "UPSTREAM_TIMEOUT");
  });

  it("classifies DNS errors", () => {
    const err = classifyError(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    assert.equal(err.code, "DNS_ERROR");
  });

  it("classifies private address errors", () => {
    const err = classifyError(new Error("private address"));
    assert.equal(err.code, "PRIVATE_ADDRESS");
  });

  it("classifies generic upstream errors", () => {
    const err = classifyError(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    assert.equal(err.code, "UPSTREAM_ERROR");
  });

  it("falls back to INTERNAL_ERROR for unknown", () => {
    const err = classifyError(new Error("something weird"));
    assert.equal(err.code, "INTERNAL_ERROR");
  });
});
