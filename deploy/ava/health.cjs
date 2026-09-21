// Real readiness: fresh DoH lookup, browser availability, and a scrape through the API.
const dns = require('node:dns').promises;
(async () => {
  await dns.lookup('example.com');
  const browser = await fetch('http://browser:3000/health', {signal: AbortSignal.timeout(4000)});
  if (!browser.ok) throw Error('browser unavailable');
  const response = await fetch('http://127.0.0.1:3002/v2/scrape', {
    method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(25000),
    body:JSON.stringify({url:'https://example.com',formats:['markdown'],waitFor:50,timeout:22000,maxAge:0}),
  });
  const body = await response.json();
  if (!response.ok || !body.success || !body.data?.markdown?.includes('Example Domain') || body.data.warning || (body.data.metadata?.statusCode || 200) >= 400) {
    throw Error('scrape readiness failed');
  }
})().catch(error => { console.error(error.message); process.exitCode=1; });
