# Intake form backend (Cloudflare Worker + Mailgun)

Handles `POST /api/intake` (Contact form) and `POST /api/subscribe`
(newsletter signup) from `m4quickstudios.com`, and emails each submission
to `m4quick@gmail.com` via Mailgun (the domain's existing Mailgun MX/SPF
setup — no new email infra needed).

## Deploy

1. Install wrangler if you don't have it: `npm install -g wrangler`
2. `cd worker && wrangler login` (opens a browser to authorize your Cloudflare account)
3. Set the Mailgun API key as an encrypted secret (never goes in code or git):
   `wrangler secret put MAILGUN_API_KEY`
   — paste your Mailgun **private API key** when prompted.
4. Deploy: `wrangler deploy`
5. In the Cloudflare dashboard: **Workers & Pages → m4quick-intake → Settings → Triggers → Routes → Add route**
   - Route: `m4quickstudios.com/api/*`
   - Zone: `m4quickstudios.com`

That's it — the rest of the site keeps being served by GitHub Pages;
Cloudflare only intercepts requests under `/api/*` and routes them to
this Worker.

## Test

```
curl -i -X POST https://m4quickstudios.com/api/subscribe -d "email=test@example.com"
```

Should return a `303` redirect to `/?submitted=newsletter#newsletter` and
you should get an email at m4quick@gmail.com within a few seconds.
