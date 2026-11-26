const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = "http://maps.fixture.test:8080";
const landed = "http://maps.fixture.test:8081";
const rebranded = "http://rebranded.fixture2.test:8082";
const api = "http://api:3002";
const browser = "http://browser:3000";

function serveFixture() {
  const getCounts = {};
  const serve = async (request, response) => {
    const { pathname } = new URL(request.url, fixture);
    const localPort = request.socket.localPort;
    const onLandedOrigin = localPort === 8081;
    const onRebrandedOrigin = localPort === 8082;
    if (request.method === "GET") {
      getCounts[pathname] = (getCounts[pathname] ?? 0) + 1;
    }
    let body;
    let contentType = "text/html";
    switch (pathname) {
      case "/robots.txt":
        contentType = "text/plain";
        body = onRebrandedOrigin
          ? "User-agent: *\nAllow: /\nDisallow: /secret\n"
          : onLandedOrigin
            ? "User-agent: *\nDisallow: /private\nDisallow: /denied-landing\n"
            : `User-agent: *\nDisallow: /docs/hidden\nDisallow: /denied-source\nSitemap: ${fixture}/sitemap.xml\n`;
        break;
      case "/sitemap.xml":
        contentType = "text/xml";
        body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${fixture}/docs/listed</loc></url>
          <url><loc>${fixture}/broken/listed</loc></url>
        </urlset>`;
        break;
      case "/catalog/sitemap.xml":
        contentType = "text/xml";
        body = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${fixture}/fast-child-sitemap.xml</loc></sitemap>
          <sitemap><loc>${fixture}/hung-child-sitemap.xml</loc></sitemap>
        </sitemapindex>`;
        break;
      case "/fast-child-sitemap.xml":
        contentType = "text/xml";
        body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${fixture}/catalog/one</loc></url>
          <url><loc>${fixture}/catalog/two</loc></url>
          <url><loc>${fixture}/catalog/three</loc></url>
        </urlset>`;
        break;
      case "/hung-child-sitemap.xml":
        await delay(15_000);
        contentType = "text/xml";
        body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
        break;
      case "/docs":
        body = `<html><body>
          <a href="/docs">Starting page</a>
          <a href="/docs/listed?ref=home">Sitemap result</a>
          <a href="/docs/hidden">Robots exclusion</a>
          <a href="/docs/extra?ref=home#heading">New page</a>
          <a href="/docs/extra">Duplicate new page</a>
          <a href="/docs/guide.pdf">Document</a>
          <a href="/docs/picture.png">Image</a>
          <a href="/docs/download.zip">Archive</a>
          <a href="/docs-old/spillover">Sibling path</a>
          <a href="/outside">Path exclusion</a>
          <a href="http://elsewhere.test/docs/other">Other site</a>
        </body></html>`;
        break;
      case "/slow-shell":
      case "/dynamic":
        if (
          pathname === "/slow-shell" &&
          request.method === "GET" &&
          getCounts[pathname] === 1
        ) {
          await delay(1_850);
        }
        body = `<html><body><script>
          setTimeout(() => {
            const link = document.createElement("a");
            link.href = "${pathname}/extra";
            link.textContent = "Rendered link";
            document.body.append(link);
          }, 250);
        </script></body></html>`;
        break;
      case "/cf-shell":
        body = `<html><body>
          <a href="/cdn-cgi/l/email-protection">Contact</a>
          <a href="/_next/image?url=%2Fhero.png">Hero</a>
          <script>
            setTimeout(() => {
              const link = document.createElement("a");
              link.href = "/cf-shell/team";
              link.textContent = "Team";
              document.body.append(link);
            }, 150);
          </script>
        </body></html>`;
        break;
      case "/waf-protected":
        if ((getCounts[pathname] ?? 0) <= 1) {
          response.statusCode = 403;
          body = "Forbidden by WAF on plain fetch";
        } else {
          body = '<html><body><a href="/waf-protected/pricing">Pricing</a></body></html>';
        }
        break;
      case "/single-page":
        body = `<html><head><title>Acme Robotics</title></head><body>
          <h1>Autonomous Warehouse Manipulation</h1>
          <p>Acme Robotics builds dexterous mobile manipulators for cold-chain fulfillment centers across North America and Europe with deterministic grasp planning.</p>
          <a href="https://github.com/acme/robotics">GitHub</a>
        </body></html>`;
        break;
      case "/challenge-wall":
        body = `<html><head><title>Just a moment...</title></head><body>
          <p>Checking your browser before accessing this website. Verify you are human to continue.</p>
        </body></html>`;
        break;
      case "/slow-domain-redirect":
        if (request.method === "HEAD" || (getCounts[pathname] ?? 0) <= 1) {
          await delay(2_300);
        }
        response.writeHead(301, { Location: `${rebranded}/` });
        response.end();
        return;
      case "/":
        if (onRebrandedOrigin) {
          body =
            '<html><body><a href="/product">Product</a><a href="/secret/plan">Secret</a></body></html>';
          break;
        }
        response.statusCode = 404;
        body = "Missing";
        break;
      case "/move":
      case "/denied-source":
      case "/move-to-denied":
        response.writeHead(302, {
          Location:
            landed +
            (pathname === "/move-to-denied" ? "/denied-landing" : "/landing"),
        });
        response.end();
        return;
      case "/landing":
        body =
          '<html><a href="/public-page">Public</a><a href="/private/page">Private</a></html>';
        break;
      case "/denied-landing":
        body = '<html><a href="/unlisted-page">Unlisted</a></html>';
        break;
      case "/not-found":
        response.statusCode = 404;
        body = "Not Found";
        break;
      case "/disconnect/a":
      case "/disconnect/b":
      case "/disconnect/c":
        if (request.method === "GET" && getCounts[pathname] > 1) {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.flushHeaders();
          const timer = setTimeout(() => response.end("Done"), 7_000);
          response.once("close", () => clearTimeout(timer));
          return;
        }
        body = "<html><body>Empty shell</body></html>";
        break;
      case "/stats":
        contentType = "application/json";
        body = JSON.stringify(getCounts);
        break;
      case "/broken":
        response.statusCode = 503;
        body = "Unavailable";
        break;
      case "/installer.msi":
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="AgentSetup.msi"',
        });
        response.end(
          Buffer.concat([
            Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            Buffer.alloc(64),
          ]),
        );
        return;
      case "/octet-note.txt":
        contentType = "application/octet-stream";
        body =
          "Ava octet-stream plain text release notes for self-hosted verification.";
        break;
      default:
        response.statusCode = 404;
        body = "Missing";
    }
    response.setHeader("Content-Type", contentType);
    response.end(body);
  };
  createServer(serve).listen(8080, "0.0.0.0");
  createServer(serve).listen(8081, "0.0.0.0");
  createServer(serve).listen(8082, "0.0.0.0");
}

async function mapWithMeta(
  path,
  options = {},
  signal = AbortSignal.timeout(18_000),
) {
  const response = await fetch(`${api}/v2/map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fixture + path, timeout: 15_000, ...options }),
    signal,
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.success, true);
  return {
    links: result.links.map((link) => link.url),
    outcome: response.headers.get("x-firecrawl-map-outcome"),
    statusCode: response.headers.get("x-firecrawl-map-status-code"),
    landedUrl: response.headers.get("x-firecrawl-map-landed-url"),
  };
}

async function map(path, options = {}, signal = AbortSignal.timeout(18_000)) {
  return (await mapWithMeta(path, options, signal)).links;
}

if (process.argv[2] === "fixture") {
  serveFixture();
} else {
  test("Map appends same-site links in scope without replacing sitemap results", async () => {
    const expected = [
      `${fixture}/docs/listed`,
      `${fixture}/docs`,
      `${fixture}/docs/extra`,
      `${fixture}/docs/guide.pdf`,
    ];
    assert.deepEqual(await map("/docs"), expected);
    assert.deepEqual(await map("/docs", { limit: 1 }), expected.slice(0, 1));
  });

  test("sitemap-only Map skips starting-page discovery", async () => {
    assert.deepEqual(await map("/docs", { sitemap: "only" }), [
      `${fixture}/docs/listed`,
      `${fixture}/docs`,
    ]);
  });

  test("Map retries a successful empty starting page with a browser", async () => {
    assert.deepEqual(await map("/dynamic"), [
      `${fixture}/dynamic`,
      `${fixture}/dynamic/extra`,
    ]);
  });

  test("Map preserves the sitemap when starting-page retrieval fails", async () => {
    assert.deepEqual(await map("/broken"), [
      `${fixture}/broken/listed`,
      `${fixture}/broken`,
    ]);
  });

  test("Map checks robots rules on both sides of a redirect", async () => {
    const links = await map("/move", { filterByPath: false });
    assert.ok(links.includes(`${landed}/public-page`), JSON.stringify(links));
    assert.ok(!links.includes(`${landed}/private/page`), JSON.stringify(links));
    const fromDenied = await map("/denied-source", { filterByPath: false });
    assert.ok(!fromDenied.includes(`${landed}/public-page`));
    const toDenied = await map("/move-to-denied", { filterByPath: false });
    assert.ok(!toDenied.includes(`${landed}/unlisted-page`));
  });

  test("Map retains the browser retry when less than three seconds remain", async () => {
    assert.ok(
      (await map("/slow-shell", { timeout: 4_500 })).includes(
        `${fixture}/slow-shell/extra`,
      ),
    );
  });

  test("A 404 starting page gets one plain fetch and no render", async () => {
    const res = await mapWithMeta("/not-found");
    assert.equal(res.outcome, "http_not_found");
    assert.equal(res.statusCode, "404");
    const counts = await (await fetch(`${fixture}/stats`)).json();
    assert.equal(counts["/not-found"], 1);
  });

  test("Map retries a WAF-blocked 403 starting page with a browser", async () => {
    const res = await mapWithMeta("/waf-protected");
    assert.deepEqual(res.links, [
      `${fixture}/waf-protected`,
      `${fixture}/waf-protected/pricing`,
    ]);
    assert.equal(res.outcome, "links_found");
  });

  test("Utility /cdn-cgi and /_next links do not suppress browser link discovery", async () => {
    const res = await mapWithMeta("/cf-shell");
    assert.deepEqual(res.links, [
      `${fixture}/cf-shell`,
      `${fixture}/cf-shell/team`,
    ]);
    assert.equal(res.outcome, "links_found");
  });

  test("Map follows slow cross-domain redirects and honors the landed robots.txt", async () => {
    const res = await mapWithMeta("/slow-domain-redirect", {
      filterByPath: false,
    });
    assert.ok(res.links.includes(`${rebranded}/product`), JSON.stringify(res.links));
    assert.ok(!res.links.includes(`${rebranded}/secret/plan`), JSON.stringify(res.links));
    assert.equal(res.outcome, "links_found");
  });

  test("Map stops sitemap index recursion early once limit is satisfied", async () => {
    const started = Date.now();
    const links = await map("/catalog", {
      limit: 2,
      timeout: 8_000,
    });
    assert.deepEqual(links, [`${fixture}/catalog/one`, `${fixture}/catalog/two`]);
    assert.ok(Date.now() - started < 5_000, "should abort hung child sitemap");
  });

  test("Map distinguishes verified single-page sites from sub-paths and challenge walls", async () => {
    const single = await mapWithMeta("/single-page", { filterByPath: false });
    assert.equal(single.outcome, "verified_single_page");

    const subpathScoped = await mapWithMeta("/single-page");
    assert.deepEqual(subpathScoped.links, [`${fixture}/single-page`]);
    assert.equal(subpathScoped.outcome, "blocked_or_challenge");

    const wall = await mapWithMeta("/challenge-wall", { filterByPath: false });
    assert.equal(wall.outcome, "blocked_or_challenge");
  });

  test("Scrape rejects .msi OLE2 installers while preserving UTF-8 text under application/octet-stream", async () => {
    const msiRes = await fetch(`${api}/v2/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${fixture}/installer.msi`,
        formats: ["markdown"],
        timeout: 10_000,
      }),
    });
    const msiBody = await msiRes.json();
    assert.equal(msiBody.success, false, JSON.stringify(msiBody));
    assert.equal(msiBody.code, "SCRAPE_UNSUPPORTED_FILE_ERROR");

    const txtRes = await fetch(`${api}/v2/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${fixture}/octet-note.txt`,
        formats: ["markdown"],
        waitFor: 0,
        timeout: 10_000,
      }),
    });
    const txtBody = await txtRes.json();
    assert.equal(txtRes.status, 200, JSON.stringify(txtBody));
    assert.equal(txtBody.success, true);
    assert.match(txtBody.data.markdown, /Ava octet-stream plain text release notes/);
  });

  test("Map caps browser retries and releases pages after client disconnects", async () => {
    const activePages = async () =>
      (await (await fetch(`${browser}/health`)).json()).activePages;
    const waitForPages = async (expected, timeout) => {
      const deadline = Date.now() + timeout;
      do {
        if ((await activePages()) === expected) return;
        await delay(50);
      } while (Date.now() < deadline);
      assert.equal(await activePages(), expected);
    };
    const clients = Array.from({ length: 3 }, () => new AbortController());
    const responses = clients.map((client, index) =>
      map(`/disconnect/${"abc"[index]}`, {}, client.signal).catch(
        (error) => error,
      ),
    );
    try {
      await waitForPages(2, 3_000);
      const first = await Promise.race([
        ...responses,
        delay(1_000).then(() => null),
      ]);
      assert.ok(
        Array.isArray(first),
        "a third Map should skip its browser retry",
      );
      clients.forEach((client) => client.abort());
      const completed = await Promise.all(responses);
      assert.equal(
        completed.filter((result) => result.name === "AbortError").length,
        2,
      );
      await waitForPages(0, 1_500);
    } finally {
      clients.forEach((client) => client.abort());
      await Promise.all(responses);
    }
  });
}
