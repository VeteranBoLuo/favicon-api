import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handle } from "../src/index.js";

let server;
let baseUrl;

before(async () => {
  server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("serves the interactive demo", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(await response.text(), /Any site's favicon/);
});

test("serves health checks behind a path prefix", async () => {
  const response = await fetch(`${baseUrl}/favimg/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("rejects unsupported methods", async () => {
  const response = await fetch(baseUrl, { method: "POST" });
  assert.equal(response.status, 405);
});

test("rejects invalid target URLs", async () => {
  const response = await fetch(`${baseUrl}/?url=file:///etc/passwd`);
  assert.equal(response.status, 400);
});
