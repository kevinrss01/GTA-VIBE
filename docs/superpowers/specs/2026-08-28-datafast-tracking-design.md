# DataFast tracking integration

## Goal

Load DataFast analytics on the production GTA Vibe site at `gta-vibe.com` using the website identifier supplied by the user.

## Design

Add the following deferred third-party script to the existing `<head>` in `index.html`:

```html
<script
  defer
  data-website-id="dfid_vtFkOhN3FDNWblelfDfZZ"
  data-domain="gta-vibe.com"
  src="https://datafa.st/js/script.js"
></script>
```

The integration uses DataFast's direct CDN loader. It does not enable localhost tracking, inject custom events, or add a first-party proxy. Because the script is deferred and analytics is non-critical, a DataFast outage must not block parsing or application startup.

## Verification and release

1. Run the repository's type check, lint, unit tests, and production build.
2. Confirm the generated production HTML contains the exact DataFast attributes and URL.
3. Serve the production build and verify the application still loads without an uncaught console error.
4. Commit the focused change, push it to `main`, and wait for the established Vercel production deployment.
5. Confirm `https://gta-vibe.com` serves the script tag and that the browser requests the DataFast loader.

## Scope

No custom goals, revenue attribution, consent-management changes, application UI changes, or analytics proxy are included.
