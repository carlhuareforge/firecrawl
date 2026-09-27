# Ava local scrape deployment

Pinned Firecrawl source: v2.11.376 / 95c8ab18f524d1aa813cca2a6dc8bd39191504ec.
The API image contains that BUILD_SHA. The browser base image is pinned separately
and its compiled application matches this checkout. No Firecrawl API code was changed.

Run from this repository:

```sh
docker compose -f deploy/ava/compose.yaml up -d --build --wait
```

API: http://127.0.0.1:3402. Only the API port is published, on loopback.
The briefer enables it with `FIRECRAWL_LOCAL_URL=http://127.0.0.1:3402`.
Search and map remain on Cloud. Batch tools are grouped by the briefer using bounded
single-page requests; this reduced server does not provide working async batch/crawl.

Resources: API 4 CPUs/2 GiB, browser 16 CPUs/5 GiB and 20 simultaneous pages,
Redis 1 CPU/256 MiB. These are maximums, not reservations. The current Docker VM
has 16 virtual CPUs and 32 GiB (raised from 8 GiB on 2026-09-27; at 20 pages the 8 GiB VM was already swapping). The briefer caps local HTTP concurrency at 20 (including its readiness probes).
Batch calls have 16 dedicated coordinator workers and at most four page workers
each; ordinary tools retain their separate executor. Page admission can wait up
to 120 seconds without consuming the 20-second fetch budget. Multiple briefer processes each have their
own limits, so do not multiply processes without reducing those limits.

Bandwidth, not CPU, limits local scraping: this host's route tops out near 24 Mbit/s.
The browser therefore skips images, video and fonts (`BLOCK_RESOURCE_TYPES: image,media,font`;
the page navigation itself is never blocked). The patch lives in
`playwright-api.block-resources.js`, copied over the upstream `dist/api.js` in
`Dockerfile.browser` after a checksum check, so a base-image bump fails the build instead of
silently dropping it. Upstream `BLOCK_MEDIA` does nothing (a later catch-all route always
continues). Remove the variable and recreate the browser to roll back without a rebuild.
In a 300-URL A/B this gave 2.2x the accepted pages and cut timeouts from 28% to 3%.
Raising page concurrency above 20 does not help: the link, not the browser, is the limit.

Persistence: named `redis-data` volume with AOF (every-second fsync). API/browser
are replaceable; retain research evidence in the briefer's existing run artifacts.
`docker compose ... down` retains the volume; `down -v` deletes it. No PostgreSQL
or RabbitMQ is needed for this deployment. Logs rotate at 3 files of 10 MB each.

This host uses Clash Verge. `dns.cjs` resolves public names through Google DNS over
HTTPS using the existing Clash proxy at host.docker.internal:7897, with bounded,
TTL-aware in-process caching (five-second negative cache and bounded eviction); localhost and Docker service names use normal DNS.
It does not disable Firecrawl's private-address checks. The browser image adds curl
and CA certificates for this helper. If the proxy is unavailable, requests fail and
the briefer can fall back to Cloud. No static DNS snapshot or system DNS changes
are required. On a host without Clash, remove NODE_OPTIONS/AVA_DOH_PROXY and the
DNS helper mounts when using ordinary real-IP DNS.

The API Docker health check performs a fresh DoH lookup, checks the browser and
scrapes example.com with caching disabled. The briefer smoke-scrapes that known
page once, before its first real page (a failed check is retried after 5 seconds);
after that there is no circuit breaker and no per-site block: a page goes to Cloud
only for its own failure. DNS failures and missing browser dependencies therefore
fail readiness rather than passing on API homepage liveness alone. An unhealthy
status does not itself restart a running process. Containers restart after
process exits, and the briefer's watchdog (one per host) restarts the api service
when it stops answering.

The api uses Firecrawl's Go HTML-to-markdown converter (USE_GO_MARKDOWN_PARSER=true).
The default Turndown table plugin ran on the API's only Node thread and froze every
request for 12-108 s on pages with huge tables. Known limits of the Go path: a Go
conversion error is not surfaced (partial output is returned), there is no
per-conversion timeout, and a native crash ends the API process, which then
restarts under `restart: unless-stopped` while in-flight pages fall back to Cloud. Keep images pinned,
update deliberately, and run the scraper contract checks before an upgrade.

Rollback: clear FIRECRAWL_LOCAL_URL or set FIRECRAWL_LOCAL_FORCE_CLOUD=true before
starting the briefer; the prior Cloud route remains available. No data migration.

Fork: origin is the user's fork; upstream is https://github.com/firecrawl/firecrawl.
Pull upstream updates on a branch, update image digests to the matching builds,
and repeat the batch-format and live-brief checks before deploying.

If an API source patch is needed, build `apps/api/Dockerfile` from this fork and
change the Compose API image to that build; editing the checkout alone does not
change the pinned prebuilt image. The current fork changes deployment files only.
