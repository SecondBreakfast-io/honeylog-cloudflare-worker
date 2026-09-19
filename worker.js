/**
 * Cloudflare Worker for Honeylog pageviews.
 *
 * Uses Cloudflare's configured origin unless ORIGIN_URL is set, then sends one
 * Honeylog event after each request.
 * Required secrets/env:
 * - HONEYLOG_API_URL
 * - HONEYLOG_INGESTION_SECRET
 * - HONEYLOG_SITE_DOMAIN
 *
 * Optional:
 * - ORIGIN_URL (optional override upstream origin, example: "https://origin.example.com")
 * - HONEYLOG_API_KEY
 * - HONEYLOG_SITE_SCHEME (default: "https")
 * - HONEYLOG_EVENT_NAME (default: "pageview")
 * - HONEYLOG_SKIP_PATH_REGEX (default: "\\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf)$")
 */

const textEncoder = new TextEncoder();
const DEFAULT_SKIP_PATH_REGEX = "\\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf)$";

export default {
  async fetch(request, env, ctx) {
    const incomingUrl = new URL(request.url);
    const missingEnv = findMissingRequiredEnv(env);
    const skipRegex = compileRegex(env.HONEYLOG_SKIP_PATH_REGEX || DEFAULT_SKIP_PATH_REGEX);
    const shouldTrack = !skipRegex || !skipRegex.test(incomingUrl.pathname);
    const startedAt = Date.now();

    const response = await fetch(
      resolveUpstreamRequest(request, incomingUrl, env.ORIGIN_URL, env.HONEYLOG_API_URL),
    );

    if (missingEnv.length > 0) {
      console.error(
        `Honeylog tracking disabled: missing required environment variable(s): ${missingEnv.join(", ")}`,
      );
      return response;
    }

    if (!shouldTrack) {
      return response;
    }

    const event = buildEvent(request, response, env, startedAt);
    return trackResponseBodyAndSend(response, event, env, ctx, startedAt, request.method);
  },
};

function findMissingRequiredEnv(env) {
  const required = [
    "HONEYLOG_API_URL",
    "HONEYLOG_INGESTION_SECRET",
    "HONEYLOG_SITE_DOMAIN",
  ];

  return required.filter((key) => !env[key] || String(env[key]).trim() === "");
}

function resolveUpstreamRequest(request, incomingUrl, originUrlRaw, honeylogApiUrlRaw) {
  if (!originUrlRaw || String(originUrlRaw).trim() === "") {
    return request;
  }

  const originUrl = safeParseUrl(originUrlRaw);
  if (!originUrl) {
    console.error("Invalid ORIGIN_URL; using Cloudflare origin.");
    return request;
  }

  const honeylogApiUrl = safeParseUrl(honeylogApiUrlRaw);
  if (honeylogApiUrl && sameHost(originUrl, honeylogApiUrl)) {
    console.error("ORIGIN_URL matches HONEYLOG_API_URL host; using Cloudflare origin.");
    return request;
  }

  const upstreamUrl = rewriteToOrigin(incomingUrl, originUrl.toString());
  return new Request(upstreamUrl.toString(), request);
}

function rewriteToOrigin(incomingUrl, originUrlRaw) {
  const originUrl = new URL(originUrlRaw);
  const rewritten = new URL(incomingUrl.toString());
  rewritten.protocol = originUrl.protocol;
  rewritten.hostname = originUrl.hostname;
  rewritten.port = originUrl.port;
  return rewritten;
}

function buildEvent(request, response, env, startedAtMs) {
  const requestUrl = new URL(request.url);
  const requestHost = normalizeRequestHost(requestUrl.host) || sanitizeDomain(requestUrl.hostname);
  const siteDomain = sanitizeDomain(env.HONEYLOG_SITE_DOMAIN);
  const siteScheme = String(env.HONEYLOG_SITE_SCHEME || "https").toLowerCase();
  const eventName = String(env.HONEYLOG_EVENT_NAME || "pageview");

  const event = {
    n: eventName,
    d: siteDomain,
    u: `${siteScheme}://${requestHost || siteDomain}${requestUrl.pathname}${requestUrl.search}`,
    method: request.method.toUpperCase(),
    status_code: response.status,
    timestamp: new Date().toISOString(),
  };

  const referer = request.headers.get("referer");
  if (referer) {
    event.r = referer;
  }

  const userAgent = request.headers.get("user-agent");
  if (userAgent) {
    event.ua = userAgent;
  }

  const trackedHeaders = buildTrackedRequestHeaders(request);
  if (Object.keys(trackedHeaders).length > 0) {
    event.headers = trackedHeaders;
  }

  const ip = extractClientIp(request);
  if (ip) {
    event.ip = ip;
  }

  const contentLength = toPositiveInt(response.headers.get("content-length"));
  if (contentLength !== null) {
    event.bytes_sent = contentLength;
  }

  const responseTimeMs = Date.now() - startedAtMs;
  if (responseTimeMs >= 0) {
    event.response_time = responseTimeMs;
  }

  const cfRay = request.headers.get("cf-ray");
  if (cfRay) {
    event.p = { cf_ray: cfRay };
  }

  return event;
}

function buildTrackedRequestHeaders(request) {
  const headerNames = [
    "accept-language",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "sec-purpose",
    "purpose",
    "x-moz",
    "sec-speculation-tags",
  ];
  const headers = {};

  for (const name of headerNames) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }

  return headers;
}

function trackResponseBodyAndSend(response, event, env, ctx, startedAtMs, requestMethod) {
  if (event.bytes_sent !== undefined || !canCountResponseBody(response, requestMethod)) {
    if (event.bytes_sent === undefined) {
      event.bytes_sent = 0;
    }
    updateResponseTime(event, startedAtMs);
    scheduleHoneylogSend(event, env, ctx);
    return response;
  }

  let bytesSent = 0;
  const meteredBody = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytesSent += chunkByteLength(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        event.bytes_sent = bytesSent;
        updateResponseTime(event, startedAtMs);
        scheduleHoneylogSend(event, env, ctx);
      },
    }),
  );

  return new Response(meteredBody, response);
}

function canCountResponseBody(response, requestMethod) {
  if (String(requestMethod || "").toUpperCase() === "HEAD") {
    return false;
  }

  if (!response.body) {
    return false;
  }

  return ![101, 204, 205, 304].includes(response.status);
}

function chunkByteLength(chunk) {
  if (chunk && typeof chunk.byteLength === "number") {
    return chunk.byteLength;
  }

  if (typeof chunk === "string") {
    return textEncoder.encode(chunk).byteLength;
  }

  if (chunk && typeof chunk.length === "number") {
    return chunk.length;
  }

  return 0;
}

function updateResponseTime(event, startedAtMs) {
  const responseTimeMs = Date.now() - startedAtMs;
  if (responseTimeMs >= 0) {
    event.response_time = responseTimeMs;
  }
}

function scheduleHoneylogSend(event, env, ctx) {
  const task = sendEventToHoneylog(event, env).catch((err) => {
    console.error("Honeylog send failed:", err);
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task);
  } else {
    // Non-Worker runtimes should not block response delivery.
    void task;
  }
}

async function sendEventToHoneylog(event, env) {
  const siteDomain = sanitizeDomain(env.HONEYLOG_SITE_DOMAIN);
  const body = JSON.stringify({ events: [event] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await buildSignature(timestamp, body, env.HONEYLOG_INGESTION_SECRET);

  const headers = {
    "Content-Type": "application/json",
    "X-Honeylog-Site": siteDomain,
    "X-Honeylog-Timestamp": timestamp,
    "X-Honeylog-Signature": signature,
  };

  const apiKey = env.HONEYLOG_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(env.HONEYLOG_API_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Honeylog returned HTTP ${response.status}`);
  }
}

async function buildSignature(timestamp, body, secret) {
  const payload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toHex(signature);
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function sanitizeDomain(domain) {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function normalizeRequestHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  try {
    return new URL(`https://${normalized}`).host;
  } catch (_err) {
    return "";
  }
}

function toPositiveInt(value) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function compileRegex(value) {
  if (!value) {
    return null;
  }
  try {
    return new RegExp(normalizeRegexPattern(value), "i");
  } catch (err) {
    console.error("Invalid HONEYLOG_SKIP_PATH_REGEX, tracking all paths:", err);
    return null;
  }
}

function normalizeRegexPattern(value) {
  // Cloudflare text inputs need "\\.", while JSON examples show "\\\\.".
  // Accept both so copied dashboard values still filter static assets.
  return String(value).trim().replaceAll("\\\\.", "\\.");
}

function extractClientIp(request) {
  const cfIp = normalizeIp(request.headers.get("cf-connecting-ip"));
  if (cfIp) {
    return cfIp;
  }

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = normalizeIp(String(xff).split(",")[0]);
    if (first) {
      return first;
    }
  }

  return normalizeIp(request.headers.get("x-real-ip"));
}

function normalizeIp(value) {
  if (!value) {
    return null;
  }

  let ip = String(value).trim();
  if (!ip) {
    return null;
  }

  // Remove IPv6 brackets if present.
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  return ip;
}

function safeParseUrl(value) {
  try {
    return new URL(String(value));
  } catch (_err) {
    return null;
  }
}

function sameHost(left, right) {
  return left.hostname === right.hostname && normalizedPort(left) === normalizedPort(right);
}

function normalizedPort(url) {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === "http:") {
    return "80";
  }
  if (url.protocol === "https:") {
    return "443";
  }
  return "";
}
