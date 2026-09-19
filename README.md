# Honeylog Cloudflare Worker

Send Honeylog pageview events from a site that uses Cloudflare. The Worker passes visitors through to your normal site and sends one Honeylog event in the background.

This Worker sends each event individually. It does not batch events or use Durable Objects.

## Cloudflare Dashboard Setup

This setup uses only the Cloudflare dashboard. You do not need GitHub, GitLab, or the command line.

### 1. Create the Worker

1. Open Cloudflare.
2. Go to **Workers & Pages**.
3. Select **Create application**.
4. Select **Create Worker**.
5. Name it `honeylog-worker`.
6. Select **Deploy**.

### 2. Paste the Worker code

1. Open the Worker you just created.
2. Select **Edit Code** or **Quick Edit**.
3. Delete the starter code.
4. Open `worker.js` from this repository. If you are viewing it on GitHub, select **Raw** first.
5. Copy the full file contents and paste them into Cloudflare.
6. Select **Deploy**.

### 3. Add Honeylog values

In Cloudflare, open the Honeylog Worker and go to **Settings > Variables and Secrets**.

Select **Add** and add these as plain text variables:

- `HONEYLOG_API_URL`: copy this from Honeylog.
- `HONEYLOG_SITE_DOMAIN`: your site domain, for example `example.com`.
- `HONEYLOG_SITE_SCHEME`: use `https` unless your site uses HTTP.
- `HONEYLOG_EVENT_NAME`: use `pageview`.
- `HONEYLOG_SKIP_PATH_REGEX`: optional. If you add it, use `\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf)$`. Use one backslash in the Cloudflare dashboard, not `\\.`.
- `ORIGIN_URL`: add this only if Honeylog support tells you to set it.

Add these as secrets:

- `HONEYLOG_INGESTION_SECRET`: copy this from Honeylog.
- `HONEYLOG_API_KEY`: add this only if Honeylog gives you one.

Select **Deploy** to save the values.

Honeylog does not need your Cloudflare password or Cloudflare API key. Do not paste your Cloudflare API key into Honeylog.

### 4. Disable the workers.dev URL

Cloudflare may create a public `workers.dev` URL when the Worker is created. Honeylog does not need this URL.

In Cloudflare, open the Honeylog Worker and go to **Settings > Domains & Routes**. Find the `workers.dev` route and select **Disable**. Some Cloudflare accounts may show this under the Worker's **Domains** tab.

### 5. Add a Cloudflare route

The Worker starts handling traffic on your site after you add a route.

In Cloudflare, open the Honeylog Worker, then go to **Settings > Domains & Routes > Add > Route**.

Start with a test route:

```text
example.com/honeylog-test/*
```

After Honeylog confirms events from the test route, switch to the full-site route:

```text
example.com/*
```

## Troubleshooting

- Cloudflare asks for GitHub or GitLab: go back to **Workers & Pages** and create the Worker manually with the dashboard steps above.
- Honeylog shows no events: check that the Cloudflare route is active and that `HONEYLOG_SITE_DOMAIN` matches the site in Honeylog.
- Your site shows Honeylog API responses: remove `ORIGIN_URL`, or set it to your website origin instead of the Honeylog API URL.
- A Honeylog value is missing or invalid: the Worker still serves the site and disables tracking until the value is fixed.

## Files

- `worker.js`: Worker code
- `worker.test.js`: local tests for the Worker behavior
- `wrangler.jsonc`: Worker configuration
- `.dev.vars.example`: local secret placeholders
- `package.json`: Cloudflare setup text
