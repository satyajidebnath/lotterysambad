# Lottery Sambad — entirely on Cloudflare

Cloudflare hosts the website, downloads each day's PDF, converts its pages into PNG
using Browser Run and PDF.js, and stores the files in R2.
Visitors load saved images; visiting the site never starts a conversion.
The page checks for updated results every minute while visible and automatically
retries missing results or failed images. Existing images remain visible if a
refresh fails.

## Deploy

Install Node.js 22+ and run these commands in this folder:

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create lottery-sambad-results
npm run deploy
npx wrangler secret put ADMIN_TOKEN
```

For ADMIN_TOKEN, enter a long random password and keep it private. Enable R2 in
your Cloudflare account first; billing setup may be required even within free usage.
Wrangler configures Workers, Browser Run, R2 and a SQLite-backed Durable Object.
The deployment prints your `https://lottery-sambad.YOUR-SUBDOMAIN.workers.dev` URL.
This URL hosts the site; no separate Pages project is needed.
On Windows PowerShell, use `npm.cmd` and `npx.cmd` instead of `npm` and `npx` if
PowerShell reports that running scripts is disabled.

## Generate the first result immediately

The hourly schedule runs at minute 17 UTC. After deployment, run this PowerShell
command with your actual website URL to avoid waiting:

```powershell
$token = Read-Host 'ADMIN_TOKEN' -AsSecureString
$credential = [PSCredential]::new('admin', $token)
Invoke-RestMethod -Method Post -Uri 'https://lottery-sambad.YOUR-SUBDOMAIN.workers.dev/admin/update' -Headers @{ Authorization = 'Bearer ' + $credential.GetNetworkCredential().Password }
```

The endpoint returns `updated` or `cached`; refresh the website afterward.
If the publisher has not uploaded today's PDF, or blocks Cloudflare requests, the
update returns an error and the schedule retries. Inspect logs with `npx wrangler tail`.

## How caching works

The Worker generates MNDDMMYY.PDF from India's date. One Durable Object coalesces
overlapping updates. The validated PDF is saved before conversion, so failed
conversions retry without downloading again. A completed daily manifest stops
further conversions. Images become visible only after all pages have been saved.
The previous result remains online until the new one is ready. Images have
date-specific URLs and edge caching.

R2 retains daily files. Optionally expire the `results/` prefix after 30 days with
an R2 lifecycle rule; keep `latest.json`. PDFs over 20 MB or ten pages are rejected.
The download stops when it exceeds the size limit, and conversion stops after
120 seconds. Failed downloads and conversions never replace the published result.

## Free allowances

Browser Run includes 10 browser minutes/day on Workers Free. R2 Standard includes
10 GB-month storage and monthly operation allowances. Workers and Durable Objects
have their own free limits. Monitor actual usage; zero cost is not guaranteed.

- https://developers.cloudflare.com/browser-run/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

## Verify and preview

```sh
npm run check
npm run dry-run
npm run dev
```

Live Browser Run and R2 integration must be verified after deployment to your
account. Unit tests use mocked storage/rendering. Never publish ADMIN_TOKEN,
`.env` or `.dev.vars`. Include `vendor/` when transferring this project.

For an additional local browser check, install Chrome and run:

```sh
npm run check:browser
```

This renders a test PDF with the production renderer and checks image display,
automatic refresh, recovery from unavailable results, and invalid result data.
Set `CHROME_PATH` if Chrome is installed elsewhere. To check the publisher's
current PDF instead, run `npm run check:browser -- --live`.
Screenshots are saved to `test-artifacts/`. This check uses a local browser;
it does not deploy anything or verify Cloudflare account bindings.
