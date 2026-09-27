"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const playwright_1 = require("playwright");
const dotenv_1 = __importDefault(require("dotenv"));
const user_agents_1 = __importDefault(require("user-agents"));
const get_error_1 = require("./helpers/get_error");
const promises_1 = require("dns/promises");
const ipaddr_js_1 = __importDefault(require("ipaddr.js"));
const proxy_chain_1 = require("proxy-chain");
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 3003;
app.use(express_1.default.json());
const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
// Resource types (Playwright request.resourceType()) to skip, e.g. "image,media,font".
// Text extraction never reads them. Unset or empty means nothing extra is blocked.
const BLOCK_RESOURCE_TYPES = new Set((process.env.BLOCK_RESOURCE_TYPES || '')
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean));
const MAX_CONCURRENT_PAGES = Math.max(1, Number.parseInt((_a = process.env.MAX_CONCURRENT_PAGES) !== null && _a !== void 0 ? _a : '10', 10) || 10);
const ALLOW_LOCAL_WEBHOOKS = (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';
const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;
class InsecureConnectionError extends Error {
    constructor(blockedUrl, reason) {
        super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
        this.blockedUrl = blockedUrl;
        this.name = 'InsecureConnectionError';
    }
}
const isInternalHost = (hostname) => __awaiter(void 0, void 0, void 0, function* () {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (!host)
        return true;
    let addresses;
    if (ipaddr_js_1.default.isValid(host)) {
        addresses = [host];
    }
    else {
        try {
            addresses = (yield (0, promises_1.lookup)(host, { all: true })).map((a) => a.address);
        }
        catch (_a) {
            return true;
        }
    }
    return (addresses.length === 0 ||
        addresses.some((a) => ipaddr_js_1.default.parse(a).range() !== 'unicast'));
});
const assertSafeTargetUrl = (urlString) => __awaiter(void 0, void 0, void 0, function* () {
    let parsedUrl;
    try {
        parsedUrl = new URL(urlString);
    }
    catch (_a) {
        throw new InsecureConnectionError(urlString, 'URL is invalid');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new InsecureConnectionError(urlString, `unsupported protocol "${parsedUrl.protocol}"`);
    }
    if (!ALLOW_LOCAL_WEBHOOKS && (yield isInternalHost(parsedUrl.hostname))) {
        throw new InsecureConnectionError(urlString, 'resolves to a private/internal address');
    }
});
const buildUpstreamProxyUrl = () => {
    if (!PROXY_SERVER)
        return undefined;
    const server = PROXY_SERVER.includes('://')
        ? PROXY_SERVER
        : `http://${PROXY_SERVER}`;
    const url = new URL(server);
    if (PROXY_USERNAME)
        url.username = PROXY_USERNAME;
    if (PROXY_PASSWORD)
        url.password = PROXY_PASSWORD;
    return url.toString();
};
const startSSRFProxy = () => __awaiter(void 0, void 0, void 0, function* () {
    const server = new proxy_chain_1.Server({
        port: 0,
        host: '127.0.0.1',
        prepareRequestFunction: (_a) => __awaiter(void 0, [_a], void 0, function* ({ hostname }) {
            if (!ALLOW_LOCAL_WEBHOOKS && (yield isInternalHost(hostname))) {
                throw new proxy_chain_1.RequestError('Blocked: target resolves to a private/internal address', 403);
            }
            return { upstreamProxyUrl: buildUpstreamProxyUrl() };
        }),
    });
    yield server.listen();
    return server.port;
});
let ssrfProxyPort;
class Semaphore {
    constructor(permits) {
        this.queue = [];
        this.permits = permits;
    }
    acquire() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.permits > 0) {
                this.permits--;
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                this.queue.push(resolve);
            });
        });
    }
    release() {
        this.permits++;
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            if (nextResolve) {
                this.permits--;
                nextResolve();
            }
        }
    }
    getAvailablePermits() {
        return this.permits;
    }
    getQueueLength() {
        return this.queue.length;
    }
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);
const AD_SERVING_DOMAINS = [
    'doubleclick.net',
    'adservice.google.com',
    'googlesyndication.com',
    'googletagservices.com',
    'googletagmanager.com',
    'google-analytics.com',
    'adsystem.com',
    'adservice.com',
    'adnxs.com',
    'ads-twitter.com',
    'facebook.net',
    'fbcdn.net',
    'amazon-adsystem.com',
];
let browser;
const initializeBrowser = () => __awaiter(void 0, void 0, void 0, function* () {
    browser = yield playwright_1.chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ],
    });
});
const createContext = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (skipTlsVerification = false, userAgentOverride) {
    const userAgent = userAgentOverride || new user_agents_1.default().toString();
    const viewport = { width: 1280, height: 800 };
    const securityState = {
        blockedNavigationRequestUrl: null,
    };
    const contextOptions = {
        userAgent,
        viewport,
        ignoreHTTPSErrors: skipTlsVerification,
        serviceWorkers: 'block',
    };
    contextOptions.proxy = {
        server: `http://127.0.0.1:${ssrfProxyPort}`,
    };
    const newContext = yield browser.newContext(contextOptions);
    if (BLOCK_MEDIA) {
        yield newContext.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', (route, request) => __awaiter(void 0, void 0, void 0, function* () {
            yield route.abort();
        }));
    }
    // Intercept all requests to avoid loading ads
    yield newContext.route('**/*', (route, request) => __awaiter(void 0, void 0, void 0, function* () {
        // Skip heavy sub-resources before any lookup. A navigation always loads, so a direct
        // image or PDF URL still scrapes as before.
        if (BLOCK_RESOURCE_TYPES.has(request.resourceType()) && !request.isNavigationRequest()) {
            return route.abort('blockedbyclient');
        }
        const requestUrlString = request.url();
        try {
            yield assertSafeTargetUrl(requestUrlString);
        }
        catch (error) {
            if (error instanceof InsecureConnectionError) {
                if (request.isNavigationRequest()) {
                    securityState.blockedNavigationRequestUrl = requestUrlString;
                }
                console.warn(`Blocked request: ${requestUrlString}`);
                return route.abort('blockedbyclient');
            }
            throw error;
        }
        const hostname = new URL(requestUrlString).hostname.toLowerCase();
        if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
            console.log(hostname);
            return route.abort();
        }
        return route.continue();
    }));
    return { context: newContext, securityState };
});
const shutdownBrowser = () => __awaiter(void 0, void 0, void 0, function* () {
    if (browser) {
        yield browser.close();
    }
});
const isValidUrl = (urlString) => {
    try {
        new URL(urlString);
        return true;
    }
    catch (_) {
        return false;
    }
};
const scrapePage = (page, url, waitUntil, waitAfterLoad, timeout, checkSelector, securityState) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
    let response;
    try {
        response = yield page.goto(url, { waitUntil, timeout });
    }
    catch (error) {
        if (securityState.blockedNavigationRequestUrl) {
            throw new InsecureConnectionError(securityState.blockedNavigationRequestUrl, 'navigation to private/internal resource is not allowed');
        }
        throw error;
    }
    if (waitAfterLoad > 0) {
        yield page.waitForTimeout(waitAfterLoad);
    }
    if (checkSelector) {
        try {
            yield page.waitForSelector(checkSelector, { timeout });
        }
        catch (error) {
            throw new Error('Required selector not found');
        }
    }
    let headers = null, content = yield page.content();
    let ct = undefined;
    if (response) {
        headers = yield response.allHeaders();
        ct = (_a = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')) === null || _a === void 0 ? void 0 : _a[1];
        if (ct &&
            (ct.toLowerCase().includes('application/json') ||
                ct.toLowerCase().includes('text/plain'))) {
            content = (yield response.body()).toString('utf8'); // TODO: determine real encoding
        }
    }
    return {
        content,
        status: response ? response.status() : null,
        headers,
        contentType: ct,
    };
});
app.get('/health', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        if (!browser) {
            yield initializeBrowser();
        }
        const { context: testContext } = yield createContext();
        const testPage = yield testContext.newPage();
        yield testPage.close();
        yield testContext.close();
        res.status(200).json({
            status: 'healthy',
            maxConcurrentPages: MAX_CONCURRENT_PAGES,
            activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits(),
        });
    }
    catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error occurred',
        });
    }
}));
app.post('/scrape', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const { url, wait_after_load = 0, timeout = 15000, headers, check_selector, skip_tls_verification = false, } = req.body;
    console.log(`================= Scrape Request =================`);
    console.log(`URL: ${url}`);
    console.log(`Wait After Load: ${wait_after_load}`);
    console.log(`Timeout: ${timeout}`);
    console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
    console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
    console.log(`Skip TLS Verification: ${skip_tls_verification}`);
    console.log(`==================================================`);
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    if (!isValidUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL' });
    }
    try {
        yield assertSafeTargetUrl(url);
    }
    catch (error) {
        if (error instanceof InsecureConnectionError) {
            return res.json({
                content: '',
                pageStatusCode: 403,
                pageError: error.message,
            });
        }
        throw error;
    }
    if (!PROXY_SERVER) {
        console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
    }
    if (!browser) {
        yield initializeBrowser();
    }
    yield pageSemaphore.acquire();
    let requestContext = null;
    let securityState = null;
    let page = null;
    try {
        // Extract user-agent from request headers (case-insensitive) so it can
        // be applied at the context level.  Playwright ignores user-agent in
        // setExtraHTTPHeaders when the context already defines one (#2802).
        const userAgentOverride = headers
            ? (_a = Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')) === null || _a === void 0 ? void 0 : _a[1]
            : undefined;
        const contextBundle = yield createContext(skip_tls_verification, userAgentOverride);
        requestContext = contextBundle.context;
        securityState = contextBundle.securityState;
        page = yield requestContext.newPage();
        if (headers) {
            // A Cookie header passed through setExtraHTTPHeaders is sent on the first
            // request but DROPPED on any redirect hop (the browser regenerates the
            // redirected request from its cookie jar, which is empty). Authenticated
            // sites that 302 (e.g. to /signin when the session looks absent) then
            // land on the login page. Seed the cookie jar instead so Chromium re-sends
            // it on every request, including redirects — matching what a raw HTTP
            // client does.
            const cookieHeader = (_b = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie')) === null || _b === void 0 ? void 0 : _b[1];
            if (cookieHeader) {
                // Scope cookies to the registrable domain (e.g. ".example.com"), not
                // host-only. Authenticated pages often 302 across sibling subdomains
                // (example.com -> app.example.com); a host-only cookie set for the
                // original host would not be sent to the redirect target, leaving the
                // request unauthenticated. The Cookie header carries no domain info, so
                // we apply the eTLD+1 — broad enough to follow the redirect, and these
                // are first-party cookies being returned to their own origin anyway.
                let cookieDomain;
                try {
                    const host = new URL(url).hostname;
                    const labels = host.split('.');
                    cookieDomain = labels.length > 2 ? labels.slice(-2).join('.') : host;
                }
                catch (_c) {
                    cookieDomain = undefined;
                }
                const cookies = cookieHeader
                    .split(';')
                    .map((pair) => pair.trim())
                    .filter(Boolean)
                    .map((pair) => {
                    const eq = pair.indexOf('=');
                    if (eq === -1)
                        return null;
                    const name = pair.slice(0, eq).trim();
                    const value = pair.slice(eq + 1).trim();
                    return cookieDomain
                        ? { name, value, domain: `.${cookieDomain}`, path: '/' }
                        : { name, value, url };
                })
                    .filter((c) => c !== null);
                if (cookies.length > 0) {
                    try {
                        yield requestContext.addCookies(cookies);
                    }
                    catch (error) {
                        console.warn('Failed to seed cookies from Cookie header:', error);
                    }
                }
            }
            // Remove user-agent (already applied at the context level) and cookie
            // (now seeded into the jar) before forwarding the rest verbatim.
            const filteredHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => {
                const lower = k.toLowerCase();
                return lower !== 'user-agent' && lower !== 'cookie';
            }));
            if (Object.keys(filteredHeaders).length > 0) {
                yield page.setExtraHTTPHeaders(filteredHeaders);
            }
        }
        const result = yield scrapePage(page, url, 'load', wait_after_load, timeout, check_selector, securityState);
        const pageError = result.status !== 200 ? (0, get_error_1.getError)(result.status) : undefined;
        if (!pageError) {
            console.log(`✅ Scrape successful!`);
        }
        else {
            console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
        }
        res.json(Object.assign({ content: result.content, pageStatusCode: result.status, contentType: result.contentType }, (pageError && { pageError })));
    }
    catch (error) {
        if (error instanceof InsecureConnectionError) {
            return res.json({
                content: '',
                pageStatusCode: 403,
                pageError: error.message,
            });
        }
        console.error('Scrape error:', error);
        res
            .status(500)
            .json({ error: 'An error occurred while fetching the page.' });
    }
    finally {
        if (page)
            yield page.close();
        if (requestContext)
            yield requestContext.close();
        pageSemaphore.release();
    }
}));
const start = () => __awaiter(void 0, void 0, void 0, function* () {
    ssrfProxyPort = yield startSSRFProxy();
    yield initializeBrowser();
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
});
start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
if (require.main === module) {
    process.on('SIGINT', () => {
        shutdownBrowser().then(() => {
            console.log('Browser closed');
            process.exit(0);
        });
    });
}
