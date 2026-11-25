const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = "http://maps.fixture.test:8080";
const landed = "http://maps.fixture.test:8081";
const api = "http://api:3002";
const browser = "http://browser:3000";

function serveFixture() {
  const getCounts = {};
  const serve = async (request, response) => {
    const { pathname } = new URL(request.url, fixture);
    const onLandedOrigin = request.socket.localPort === 8081;
    if (request.method === "GET") {
      getCounts[pathname] = (getCounts[pathname] ?? 0) + 1;
    }
    let body;
    let contentType = "text/html";
    switch (pathname) {
      case "/robots.txt":
        contentType = "text/plain";
        body = onLandedOrigin
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
      case "/forbidden":
        response.statusCode = 403;
        body = "Forbidden";
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
      default:
        response.statusCode = 404;
        body = "Missing";
    }
    response.setHeader("Content-Type", contentType);
    response.end(body);
  };
  createServer(serve).listen(8080, "0.0.0.0");
  createServer(serve).listen(8081, "0.0.0.0");
}

async function map(path, options = {}, signal = AbortSignal.timeout(18_000)) {
  const response = await fetch(`${api}/v2/map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: fixture + path, timeout: 15_000, ...options }),
    signal,
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

  test("A forbidden starting page gets one plain fetch and no render", async () => {
    await map("/forbidden");
    const counts = await (await fetch(`${fixture}/stats`)).json();
    assert.equal(counts["/forbidden"], 1);
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
