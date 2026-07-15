import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const html = await response.text();
  assert.match(html, /Any site's favicon/);
  for (const language of ["zh-CN", "en", "ja", "ko"]) {
    assert.match(html, new RegExp(`data-lang="${language}"`));
  }
});

test("embedded demo script parses", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("language switch follows the browser language and can select English", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  const makeElement = (dataset = {}) => ({
    dataset,
    textContent: "",
    innerHTML: "",
    value: "baidu.com",
    classList: { add() {}, toggle() {} },
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  });
  const elements = {
    "#lookup-form": makeElement(),
    "#domain": makeElement({ i18nPlaceholder: "inputPlaceholder", i18nAria: "inputLabel" }),
    "#result": makeElement(),
    "#favicon": makeElement(),
    "#result-domain": makeElement(),
    "#result-url": makeElement(),
    "#status": makeElement({ i18n: "statusIdle" }),
    "#copy": makeElement({ i18n: "copyButton" }),
    "#meta-description": makeElement(),
  };
  const heading = makeElement({ i18nHtml: "heroTitle" });
  const languageNav = makeElement({ i18nAria: "languageLabel" });
  const languageButtons = ["zh-CN", "en", "ja", "ko"].map((language) => makeElement({ lang: language }));
  const document = {
    documentElement: { lang: "" },
    title: "",
    querySelector(selector) { return elements[selector]; },
    querySelectorAll(selector) {
      return {
        "[data-i18n]": [elements["#status"], elements["#copy"]],
        "[data-i18n-html]": [heading],
        "[data-i18n-placeholder]": [elements["#domain"]],
        "[data-i18n-aria]": [languageNav, elements["#domain"]],
        "[data-lang]": languageButtons,
        ".example": [],
      }[selector] || [];
    },
  };
  const window = {
    location: { href: "https://example.com/favimg/" },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() {},
  };
  const navigator = { languages: ["zh-CN"], language: "zh-CN", clipboard: {} };

  new Function("document", "window", "navigator", script)(document, window, navigator);
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.match(heading.innerHTML, /只需一个 URL/);
  languageButtons[1].listeners.click();
  assert.equal(document.documentElement.lang, "en");
  assert.match(heading.innerHTML, /One simple URL/);
});

test("serves brand assets behind a path prefix", async () => {
  const svgResponse = await fetch(`${baseUrl}/favimg/favicon.svg`);
  assert.equal(svgResponse.status, 200);
  assert.match(svgResponse.headers.get("content-type"), /^image\/svg\+xml/);
  assert.match(await svgResponse.text(), /favicon-api/);

  const pngResponse = await fetch(`${baseUrl}/favimg/apple-touch-icon.png`);
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get("content-type"), "image/png");

  const manifestResponse = await fetch(`${baseUrl}/favimg/site.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).name, "favicon-api");
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
