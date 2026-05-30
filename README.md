# Honeylog Cloudflare Worker Client

This client proxies requests to your current origin by default and asynchronously sends one Honeylog event per request.
If `ORIGIN_URL` is set, it proxies there instead.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FSecondBreakfast-io%2Fhoneylog-cloudflare-worker)

## Files

- `worker.js`: Worker entrypoint
- `wrangler.jsonc`: Deploy to Cloudflare / Wrangler configuration
- `.dev.vars.example`: required secret names for Cloudflare's deploy flow
- `package.json`: Cloudflare binding descriptions

## Required env vars

- `HONEYLOG_API_URL`: Honeylog ingestion endpoint (example: `https://ingest.example.com/api/events`)
- `HONEYLOG_INGESTION_SECRET`: secret used for `X-Honeylog-Signature` HMAC

## Optional env vars

- `ORIGIN_URL`: optional upstream override URL (example: `https://origin.example.com`)
- `HONEYLOG_API_KEY`: sent as `Authorization: Bearer ...`
- `HONEYLOG_SITE_DOMAIN`: force site domain in payload/header (defaults to request hostname)
- `HONEYLOG_SITE_SCHEME`: event URL scheme (default: `https`)
- `HONEYLOG_EVENT_NAME`: event name (default: `pageview`)
- `HONEYLOG_SKIP_PATH_REGEX`: skip matching paths (example: `\\.(?:css|js|png|jpg|svg|ico)$`)

## Deploy to Cloudflare

Use the button above to install the Worker through Cloudflare's hosted flow. Cloudflare handles account authentication, repository setup, and deployment. Honeylog does not need the customer's Cloudflare API key.

This directory is intended to be published as a standalone public repository, for example:

```text
https://github.com/SecondBreakfast-io/honeylog-cloudflare-worker
```

Cloudflare Deploy buttons require a public GitHub or GitLab repository. If this code remains inside a monorepo, the button can target a subdirectory, but the subdirectory must be fully isolated with its own Worker config and dependencies.

During setup, replace the example values in `wrangler.jsonc` with the values shown in the Honeylog dashboard:

```jsonc
{
  "vars": {
    "HONEYLOG_API_URL": "https://ingest.example.com/api/events",
    "HONEYLOG_SITE_DOMAIN": "example.com",
    "HONEYLOG_SITE_SCHEME": "https",
    "HONEYLOG_EVENT_NAME": "pageview",
    "HONEYLOG_SKIP_PATH_REGEX": "\\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf)$"
  }
}
```

Set `HONEYLOG_INGESTION_SECRET` when Cloudflare prompts for secrets. Set `HONEYLOG_API_KEY` only if the Honeylog site requires bearer authentication.

After deployment, add a Worker route in Cloudflare:

```text
example.com/honeylog-test/*
```

Promote to the full-site route only after Honeylog verifies the test route:

```text
example.com/*
```

## Manual Wrangler fallback

```toml
name = "honeylog-worker"
main = "worker.js"
compatibility_date = "2026-03-15"

[vars]
HONEYLOG_API_URL = "https://ingest.example.com/api/events"
HONEYLOG_SITE_DOMAIN = "example.com"
HONEYLOG_EVENT_NAME = "pageview"
HONEYLOG_SKIP_PATH_REGEX = "\\.(?:css|js|png|jpg|svg|ico)$"

# add secret with:
# wrangler secret put HONEYLOG_INGESTION_SECRET
# optional:
# wrangler secret put HONEYLOG_API_KEY
```

## Notes

- Signature format matches backend middleware: `sha256_hmac(secret, "<unix_timestamp>.<raw_json_body>")`.
- Header `X-Honeylog-Site` and payload domain `d` are aligned to avoid domain-mismatch rejection.
- If pages start showing your ingestion server responses, `ORIGIN_URL` is pointing to the wrong host. Remove it (default origin) or set it to your real website origin.
- `bytes_sent` uses `Content-Length` when present. For streamed/compressed responses without that header, the Worker counts response body chunks and sends the Honeylog event after the body finishes.
