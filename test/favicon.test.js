import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPublicHost,
  extractFaviconUrl,
  generateETag,
  isPrivateAddress,
  isValidImageBuffer,
  safeFetch,
  fetchWithTimeout,
} from "../src/favicon.js";

test("identifies private and reserved addresses", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "192.0.2.1", "198.51.100.8", "203.0.113.7", "::1", "fc00::1",
    "fe80::1", "2001:db8::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "20.205.243.166", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("rejects a hostname when any resolved address is private", async () => {
  const lookupFn = async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(() => assertPublicHost("example.test", lookupFn), { code: "PRIVATE_ADDRESS" });
});

test("revalidates redirect destinations", async () => {
  const requested = [];
  const lookupFn = async (hostname) => [{
    address: hostname === "internal.test" ? "127.0.0.1" : "1.1.1.1",
    family: 4,
  }];
  const fetchFn = async (url) => {
    requested.push(url.hostname);
    return new Response(null, { status: 302, headers: { location: "http://internal.test/secret" } });
  };

  await assert.rejects(
    () => safeFetch("https://public.test/start", {}, { lookupFn, fetchFn }),
    { code: "PRIVATE_ADDRESS" },
  );
  assert.deepEqual(requested, ["public.test"]);
});

test("rejects non-HTTP schemes", async () => {
  await assert.rejects(() => safeFetch("file:///etc/passwd"), { code: "INVALID_URL" });
});

test('rejects a non-HTTP redirect before attempting its connection', async () => {
  let calls = 0;
  await assert.rejects(() => safeFetch('https://example.test/', {}, {
    lookupFn: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchFn: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'ftp://example.test/file' } });
    },
  }), { code: 'INVALID_URL' });
  assert.equal(calls, 1);
});

test("ignores embedded data icons and falls back to favicon.ico", () => {
  const html = '<link rel="icon" href="data:image/png;base64,abc">';
  assert.equal(
    extractFaviconUrl(html, "https://example.com/page"),
    "https://example.com/favicon.ico",
  );
});

test("validates common image signatures and rejects 1x1 PNG", () => {
  const ico = Buffer.alloc(64);
  ico.set([0x00, 0x00, 0x01, 0x00]);
  assert.equal(isValidImageBuffer(ico), true);

  const png = Buffer.alloc(70);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  assert.equal(isValidImageBuffer(png), false);

  assert.equal(isValidImageBuffer(Buffer.from(`${" ".repeat(64)}<svg xmlns="http://www.w3.org/2000/svg"></svg>`)), true);
  assert.equal(isValidImageBuffer(Buffer.from(`${" ".repeat(64)}<html><svg></svg></html>`)), false);
});

test("ETags are stable and content-based", () => {
  assert.equal(generateETag(Buffer.from("same")), generateETag(Buffer.from("same")));
  assert.notEqual(generateETag(Buffer.from("same")), generateETag(Buffer.from("different")));
});

test('DNS checks obey cancellation before starting any connection', async () => {
  let connected = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('deadline')), 15);
  try {
    await assert.rejects(() => safeFetch('https://example.test/', { signal: controller.signal }, {
      lookupFn: () => new Promise(() => {}),
      fetchFn: async () => { connected = true; return new Response(''); },
    }), /deadline/);
    assert.equal(connected, false);
  } finally { clearTimeout(timer); }
});

test('HTML body reads remain under the timeout and cancel an unfinished stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(() => fetchWithTimeout('https://example.test/', {
    parentSignal: new AbortController().signal, timeoutMs: 20, maxBytes: 1024,
  }, {
    lookupFn: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchFn: async () => new Response(body),
  }), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(cancelled, true);
});

test('a winning icon cancels a losing HTML body after its headers arrived', async () => {
  let cancelled = false;
  const parent = new AbortController();
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const body = new ReadableStream({ start() { bodyStarted(); }, cancel() { cancelled = true; } });
  const pending = fetchWithTimeout('https://example.test/', {
    parentSignal: parent.signal, timeoutMs: 1000, maxBytes: 1024,
  }, {
    lookupFn: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchFn: async () => new Response(body),
  });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  parent.abort(new Error('another icon won'));
  await assert.rejects(() => pending, /another icon won/);
  assert.equal(cancelled, true);
});
