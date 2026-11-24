const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");

const fixture = "http://maps.fixture.test:8080";
const api = "http://api:3002";

function serveFixture() {
  createServer((request, response) => {
    const { pathname } = new URL(request.url, fixture);
    let body;
    let contentType = "text/html";
    switch (pathname) {
      case "/robots.txt":
        contentType = "text/plain";
        body = `User-agent: *\nDisallow: /docs/hidden\nSitemap: ${fixture}/sitemap.xml\n`;
        break;
      case "/sitemap.xml":
        contentType = "text/xml";
        body = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${fixture}/docs/listed</loc></url>
          <url><loc>${fixture}/broken/listed</loc></url>
        </urlset>`;
        break;
      case "/docs":
        body = `<html><body>
          <a href="/docs">Starting page</a>
          <a href="/docs/listed?ref=home">Sitemap result</a>
          <a href="/docs/hidden">Robots exclusion</a>
          <a href="/docs/extra?ref=home#heading">New page</a>
          <a href="/docs/extra">Duplicate new page</a>
          <a href="/outside">Path exclusion</a>
          <a href="http://elsewhere.test/docs/other">Other site</a>
        </body></html>`;
        break;
      case "/dynamic":
        body = `<html><body><script>
          setTimeout(() => {
            const link = document.createElement("a");
            link.href = "/dynamic/extra";
            link.textContent = "Rendered link";
            document.body.append(link);
          }, 1000);
        </script></body></html>`;
        break;
      case "/broken":
        response.statusCode = 503;
        body = "Unavailable";
        break;
      default:
        response.statusCode = 404;
        body = "Missing";
    }
    response.setHeader("Content-Type", contentType);
    response.end(body);
  }).listen(8080, "0.0.0.0");
}

async function map(path, options = {}) {
  const response = await fetch(`${api}/v2/map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fixture + path, timeout: 15_000, ...options }),
    signal: AbortSignal.timeout(18_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.success, true);
  return result.links.map((link) => link.url);
}

if (process.argv[2] === "fixture") {
  serveFixture();
} else {
  test("Map appends same-site links in scope without replacing sitemap results", async () => {
    const expected = [
      `${fixture}/docs/listed`,
      `${fixture}/docs`,
      `${fixture}/docs/extra`,
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
}
