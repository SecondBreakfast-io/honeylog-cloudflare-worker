import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

test("default static asset filter tracks XML and text visits", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ingestionUrls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.startsWith("https://example.com/")) {
      return new Response(null, { status: 204 });
    }

    if (url === "https://ingest.example.test/events") {
      const payload = JSON.parse(init.body);
      ingestionUrls.push(payload.events[0].u);
      return new Response(null, { status: 202 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    HONEYLOG_API_URL: "https://ingest.example.test/events",
    HONEYLOG_INGESTION_SECRET: "test-secret",
    HONEYLOG_SITE_DOMAIN: "example.com",
  };

  for (const path of [
    "/assets/app.css",
    "/assets/app.mjs",
    "/sitemap.xml",
    "/robots.txt",
  ]) {
    const backgroundTasks = [];
    await worker.fetch(new Request(`https://example.com${path}`), env, {
      waitUntil(task) {
        backgroundTasks.push(task);
      },
    });
    await Promise.all(backgroundTasks);
  }

  assert.deepEqual(ingestionUrls, [
    "https://example.com/sitemap.xml",
    "https://example.com/robots.txt",
  ]);
});

test("keeps the request subdomain while authenticating as the configured site", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ingestionRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url === "https://shop.example.com/products?category=books") {
      return new Response(null, { status: 204 });
    }

    if (url === "https://ingest.example.test/events") {
      ingestionRequests.push({ init });
      return new Response(null, { status: 202 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const backgroundTasks = [];
  const request = new Request("https://shop.example.com/products?category=books", {
    headers: {
      "accept-language": "it-IT,it;q=0.9",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-purpose": "prefetch",
    },
  });
  const env = {
    HONEYLOG_API_URL: "https://ingest.example.test/events",
    HONEYLOG_INGESTION_SECRET: "test-secret",
    HONEYLOG_SITE_DOMAIN: "example.com",
  };
  const ctx = {
    waitUntil(task) {
      backgroundTasks.push(task);
    },
  };

  const response = await worker.fetch(request, env, ctx);
  await Promise.all(backgroundTasks);

  assert.equal(response.status, 204);
  assert.equal(ingestionRequests.length, 1);

  const [{ init }] = ingestionRequests;
  const payload = JSON.parse(init.body);

  assert.equal(init.headers["X-Honeylog-Site"], "example.com");
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].d, "example.com");
  assert.equal(payload.events[0].method, "GET");
  assert.equal(payload.events[0].status_code, 204);
  assert.equal(payload.events[0].bytes_sent, 0);
  assert.ok(payload.events[0].response_time >= 0);
  assert.deepEqual(payload.events[0].headers, {
    "accept-language": "it-IT,it;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-purpose": "prefetch",
  });
  assert.equal(
    payload.events[0].u,
    "https://shop.example.com/products?category=books",
  );
});

test("serves the origin without tracking when a required env variable is missing", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const errors = [];
  console.error = (...args) => {
    errors.push(args.join(" "));
  };

  const requiredEnv = {
    HONEYLOG_API_URL: "https://ingest.example.test/events",
    HONEYLOG_INGESTION_SECRET: "test-secret",
    HONEYLOG_SITE_DOMAIN: "example.com",
  };

  for (const missingKey of Object.keys(requiredEnv)) {
    let originRequests = 0;
    let ingestionRequests = 0;
    const backgroundTasks = [];

    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url === "https://example.com/") {
        originRequests += 1;
        return new Response(null, { status: 204 });
      }

      ingestionRequests += 1;
      return new Response(null, { status: 202 });
    };

    const env = { ...requiredEnv };
    delete env[missingKey];

    const response = await worker.fetch(new Request("https://example.com/"), env, {
      waitUntil(task) {
        backgroundTasks.push(task);
      },
    });

    assert.equal(response.status, 204, missingKey);
    assert.equal(originRequests, 1, missingKey);
    assert.equal(ingestionRequests, 0, missingKey);
    assert.equal(backgroundTasks.length, 0, missingKey);
    assert.ok(errors.some((message) => message.includes(missingKey)), missingKey);
  }
});
