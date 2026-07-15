import { createHmac, randomBytes } from "node:crypto";

const MINUTE = 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAddress(value) {
  const address = String(value || "unknown").split(",")[0].trim();
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function normalizeUsageHost(rawDomain) {
  const value = String(rawDomain || "").trim();
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return null;
  }
}

export function createUsageQualifier({
  dedupeWindowMs = positiveInteger(process.env.FAVICON_USAGE_DEDUPE_MINUTES, 30) * MINUTE,
  burstWindowMs = positiveInteger(process.env.FAVICON_USAGE_BURST_MINUTES, 10) * MINUTE,
  burstLimit = positiveInteger(process.env.FAVICON_USAGE_BURST_LIMIT, 3000),
  maxEntries = positiveInteger(process.env.FAVICON_USAGE_DEDUPE_MAX, 50000),
  trustProxy = process.env.FAVICON_TRUST_PROXY === "1",
  trustedAddresses = process.env.FAVICON_USAGE_TRUSTED_IPS || "",
  secret = process.env.FAVICON_USAGE_HASH_SECRET || randomBytes(32),
} = {}) {
  const recent = new Map();
  const clientWindows = new Map();
  const trusted = new Set(
    (Array.isArray(trustedAddresses) ? trustedAddresses : String(trustedAddresses).split(","))
      .map((address) => String(address).trim())
      .filter(Boolean)
      .map(normalizeAddress),
  );
  let operations = 0;

  function fingerprint(address) {
    return createHmac("sha256", secret).update(address).digest("hex");
  }

  function prune(now, force = false) {
    operations += 1;
    if (!force && operations % 256 !== 0 && recent.size < maxEntries) return;

    for (const [key, expiresAt] of recent) {
      if (expiresAt <= now) recent.delete(key);
    }
    for (const [key, state] of clientWindows) {
      if (state.startedAt + burstWindowMs <= now) clientWindows.delete(key);
    }
    while (recent.size >= maxEntries) recent.delete(recent.keys().next().value);
    while (clientWindows.size > maxEntries) clientWindows.delete(clientWindows.keys().next().value);
  }

  function shouldCount({ clientAddress, domain, now = Date.now() }) {
    const hostname = normalizeUsageHost(domain);
    if (!hostname) return false;

    const address = normalizeAddress(clientAddress);
    const clientKey = fingerprint(address);
    const requestKey = `${clientKey}:${hostname}`;
    prune(now);

    const countedUntil = recent.get(requestKey);
    if (countedUntil && countedUntil > now) return false;

    let window = clientWindows.get(clientKey);
    if (!window || window.startedAt + burstWindowMs <= now) {
      window = { startedAt: now, count: 0 };
    }

    if (!trusted.has(address) && window.count >= burstLimit) return false;

    recent.set(requestKey, now + dedupeWindowMs);
    window.count += 1;
    clientWindows.set(clientKey, window);
    prune(now, recent.size >= maxEntries);
    return true;
  }

  return {
    shouldCount,

    shouldCountRequest(req, domain, now = Date.now()) {
      const forwardedAddress = trustProxy ? req.headers?.["x-real-ip"] : null;
      const clientAddress = forwardedAddress || req.socket?.remoteAddress || "unknown";
      return shouldCount({ clientAddress, domain, now });
    },
  };
}

export const usageQualifier = createUsageQualifier();
