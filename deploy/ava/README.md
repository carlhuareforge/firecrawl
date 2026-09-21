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

Resources: API 4 CPUs/2 GiB, browser 10 CPUs/5 GiB and 20 simultaneous pages,
Redis 1 CPU/256 MiB. These are maximums, not reservations. The current Docker VM
has 16 virtual CPUs and approximately 8 GiB. Start briefer local concurrency at 12;
its shared batch executor has 8 workers. Multiple briefer processes each have their
own limits, so do not multiply processes without reducing those limits.

Persistence: named `redis-data` volume with AOF (every-second fsync). API/browser
are replaceable; retain research evidence in the briefer's existing run artifacts.
`docker compose ... down` retains the volume; `down -v` deletes it. No PostgreSQL
or RabbitMQ is needed for this deployment. Logs rotate at 3 files of 10 MB each.

This host uses Clash Verge. `dns.cjs` resolves public names through Google DNS over
HTTPS using the existing Clash proxy at host.docker.internal:7897, with bounded,
TTL-aware in-process caching; localhost and Docker service names use normal DNS.
It does not disable Firecrawl's private-address checks. The browser image adds curl
and CA certificates for this helper. If the proxy is unavailable, requests fail and
the briefer can fall back to Cloud. No static DNS snapshot or system DNS changes
are required. On a host without Clash, remove NODE_OPTIONS/AVA_DOH_PROXY and the
DNS helper mounts when using ordinary real-IP DNS.

The health endpoints only establish process/browser availability; verify a real
scrape for end-to-end readiness. An unhealthy status does not itself restart a
running process. Containers restart after process exits. Keep images pinned,
update deliberately, and run the scraper contract checks before an upgrade.

Rollback: clear FIRECRAWL_LOCAL_URL or set FIRECRAWL_LOCAL_FORCE_CLOUD=true before
starting the briefer; the prior Cloud route remains available. No data migration.

Fork: origin is the user's fork; upstream is https://github.com/firecrawl/firecrawl.
Pull upstream updates on a branch, update image digests to the matching builds,
and repeat the batch-format and live-brief checks before deploying.

If an API source patch is needed, build `apps/api/Dockerfile` from this fork and
change the Compose API image to that build; editing the checkout alone does not
change the pinned prebuilt image. The current fork changes deployment files only.
