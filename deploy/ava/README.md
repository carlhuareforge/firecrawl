# Ava local Firecrawl deployment

The API image `ava-firecrawl-api:2.11.805-map2` builds on Firecrawl v2.11.805
(`87202348f7b3c5273c237fe8b47d3c2568f4938c`). It compiles the fork's two Map
source files into the pinned image after verifying the upstream files.
`FIRECRAWL_BUILD_SHA` records the required fork commit.
The browser image compiles `apps/playwright-service-ts/api.ts` into the separately
pinned Playwright 1.65.0 image after verifying its upstream module.

Run from this repository:

```sh
AVA_FIRECRAWL_BUILD_SHA="$(git rev-parse HEAD)" \
  docker compose -f deploy/ava/compose.yaml up -d --build --wait
```

API: http://127.0.0.1:3402. Only the API port is published, on loopback.
The briefer enables it with `FIRECRAWL_LOCAL_URL=http://127.0.0.1:3402`.
The briefer sends Search and Map to Cloud. Local `/v2/map` checks each origin's
robots rules and uses at most two simultaneous browser retries per API process.
Batch tools are grouped by the briefer using bounded
single-page requests; this reduced server does not provide working async batch/crawl.

Run the local Map regression checks against the built image. The test stack has
its own network and Redis volume. The fixture is the only website it uses.

```sh
AVA_FIRECRAWL_BUILD_SHA="$(git rev-parse HEAD)" \
  docker compose -p ava-map-test -f deploy/ava/compose.yaml -f deploy/ava/compose.map-test.yaml build api browser fixture
docker compose -p ava-map-test -f deploy/ava/compose.yaml -f deploy/ava/compose.map-test.yaml up -d --wait --no-build
docker compose -p ava-map-test -f deploy/ava/compose.yaml -f deploy/ava/compose.map-test.yaml exec -T fixture node --test /test/map.e2e.cjs
docker compose -p ava-map-test -f deploy/ava/compose.yaml -f deploy/ava/compose.map-test.yaml down --volumes
```

Resources: API 4 CPUs/2 GiB, browser 16 CPUs/5 GiB and 20 simultaneous pages,
Redis 1 CPU/256 MiB. These are maximums, not reservations. The current Docker VM
has 16 virtual CPUs and 32 GiB (raised from 8 GiB on 2026-09-27; at 20 pages the 8 GiB VM was already swapping). The briefer caps local HTTP concurrency at 20 (including its readiness probes).
Batch calls have 16 dedicated coordinator workers and at most four page workers
each; ordinary tools retain their separate executor. Page admission can wait up
to 120 seconds without consuming the 20-second fetch budget. Multiple briefer processes each have their
own limits, so do not multiply processes without reducing those limits.

Bandwidth, not CPU, limits local scraping: this host's route tops out near 24 Mbit/s.
The browser therefore skips images, video and fonts (`BLOCK_RESOURCE_TYPES: image,media,font`;
the page navigation itself is exempt). The filter lives in the TypeScript browser
source. The API and browser image builds check their upstream modules before replacing
them. Upstream `BLOCK_MEDIA` does nothing (a later catch-all route always
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

To restore the upstream API image, recreate the API service with this Compose override.

```sh
docker compose -f deploy/ava/compose.yaml -f - up -d --no-deps --no-build --wait api <<'YAML'
services:
  api:
    image: ghcr.io/firecrawl/firecrawl@sha256:3bc963b8f9ea7a7cd72e967e7fe4fb95e384ee9900bf99becbce32572ff5cda1
YAML
```

To roll back only the browser service, use the previous local browser image.

```sh
docker compose -f deploy/ava/compose.yaml -f - up -d --no-deps --no-build --wait browser <<'YAML'
services:
  browser:
    image: ava-firecrawl-browser:2.11.805-rb2
YAML
```

Fork: origin is the user's fork; upstream is https://github.com/firecrawl/firecrawl.
Pull upstream updates on a branch, update image digests to the matching builds,
and repeat the batch-format and live-brief checks before deploying.

When updating the upstream release, update the API base image and recheck the
Map source files against that release. Use the full API build at
`apps/api/Dockerfile` when a change needs different dependencies, native code,
or runtime files outside the two Map modules.
