import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageQualifier, normalizeUsageHost } from "../src/usage-qualifier.js";

test("normalizes equivalent website hosts for usage qualification", () => {
  assert.equal(normalizeUsageHost("https://www.GitHub.com/openai"), "github.com");
  assert.equal(normalizeUsageHost("github.com."), "github.com");
  assert.equal(normalizeUsageHost("file:///etc/passwd"), null);
});

test("deduplicates the same client and host without excluding bulk imports", () => {
  const qualifier = createUsageQualifier({
    dedupeWindowMs: 30 * 60 * 1000,
    burstLimit: 3000,
    secret: "test-secret",
  });
  const now = 1000000;

  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "github.com", now }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "https://www.github.com/openai", now: now + 1000 }), false);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "gitlab.com", now: now + 2000 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.11", domain: "github.com", now: now + 3000 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "github.com", now: now + 31 * 60 * 1000 }), true);
});

test("stops only anomalous counting and lets trusted importers bypass the burst limit", () => {
  const qualifier = createUsageQualifier({
    dedupeWindowMs: 30 * 60 * 1000,
    burstWindowMs: 10 * 60 * 1000,
    burstLimit: 2,
    trustedAddresses: ["127.0.0.1"],
    secret: "test-secret",
  });

  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "a.example", now: 1 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "b.example", now: 2 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "203.0.113.10", domain: "c.example", now: 3 }), false);

  assert.equal(qualifier.shouldCount({ clientAddress: "127.0.0.1", domain: "a.example", now: 1 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "127.0.0.1", domain: "b.example", now: 2 }), true);
  assert.equal(qualifier.shouldCount({ clientAddress: "127.0.0.1", domain: "c.example", now: 3 }), true);
});

test("uses the trusted reverse-proxy address only when explicitly enabled", () => {
  const request = {
    headers: { "x-real-ip": "198.51.100.20" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const proxied = createUsageQualifier({ trustProxy: true, secret: "proxy-secret" });
  const direct = createUsageQualifier({ trustProxy: false, secret: "proxy-secret" });

  assert.equal(proxied.shouldCountRequest(request, "github.com", 1), true);
  assert.equal(proxied.shouldCountRequest({ ...request, socket: { remoteAddress: "10.0.0.5" } }, "github.com", 2), false);
  assert.equal(direct.shouldCountRequest(request, "github.com", 1), true);
  assert.equal(direct.shouldCountRequest({ ...request, socket: { remoteAddress: "10.0.0.5" } }, "github.com", 2), true);
});
