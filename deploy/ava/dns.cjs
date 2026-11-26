// Process-only DNS for this Node process tree. It avoids Clash fake-IP
// responses without changing macOS DNS or Firecrawl's address safety checks.
const dns = require('node:dns');
const net = require('node:net');
const {execFile} = require('node:child_process');
const original = dns.lookup.bind(dns);
const cache = new Map();
const pending = new Map();
function makeDnsError(code, host, cause) {
  const failure = new Error('getaddrinfo ' + code + ' ' + host, cause ? {cause} : undefined);
  failure.code = code;
  failure.syscall = 'getaddrinfo';
  failure.hostname = host;
  return failure;
}
function storeCache(host, entry) {
  if (cache.size >= 10000) cache.delete(cache.keys().next().value);
  cache.set(host, entry);
}
function resolve(host) {
  const saved = cache.get(host);
  if (saved && saved.expires > Date.now()) return saved.error ? Promise.reject(saved.error) : Promise.resolve(saved.records);
  if (pending.has(host)) return pending.get(host);
  const promise = new Promise((resolve, reject) => {
    const url = 'https://dns.google/resolve?' + new URLSearchParams({name:host,type:'A'});
    execFile('/usr/bin/curl', ['--silent','--show-error','--fail','--max-time','8','--proxy',process.env.AVA_DOH_PROXY || 'http://host.docker.internal:7897',url], {maxBuffer:1024*1024}, (error,stdout) => {
      let data;
      try {
        if (error) throw error;
        data = JSON.parse(stdout);
      } catch (cause) {
        const failure = makeDnsError('EAI_AGAIN', host, cause);
        storeCache(host, {error:failure, expires:Date.now()+1000});
        return reject(failure);
      }
      const status = Number(data && data.Status);
      const records = (data.Answer || []).filter(r => r.type === 1).map(r => ({address:r.data,family:4}));
      if (records.length) {
        const ttl = Math.max(1, Math.min(300, ...data.Answer.filter(r => r.type === 1).map(r => r.TTL || 30)));
        storeCache(host, {records, expires:Date.now()+ttl*1000});
        return resolve(records);
      }
      // RCODE 3 (NXDOMAIN) or RCODE 0 (NOERROR with no IPv4 A records) means no address exists;
      // RCODE 2 (SERVFAIL), RCODE 5 (REFUSED), or malformed payloads are transient lookup errors.
      const isNotFound = status === 3 || status === 0;
      const failure = makeDnsError(isNotFound ? 'ENOTFOUND' : 'EAI_AGAIN', host);
      storeCache(host, {error:failure, expires:Date.now()+(isNotFound ? 5000 : 1000)});
      reject(failure);
    });
  }).finally(() => pending.delete(host));
  pending.set(host,promise);return promise;
}
function lookup(host, options, callback) {
  if (typeof options === 'function') {callback=options;options={};}
  if (typeof options === 'number') options={family:options};
  options=options || {};
  const name=String(host || '').toLowerCase().replace(/\.$/,'');
  if (!name || net.isIP(name) || name==='localhost' || name.endsWith('.local') || name==='host.docker.internal' || !name.includes('.')) return original(host,options,callback);
  resolve(name).then(records => {
    const filtered=records.filter(r => !options.family || options.family===r.family);
    if (!filtered.length) return callback(makeDnsError('ENOTFOUND', name));
    if (options.all) callback(null,filtered);
    else callback(null,filtered[0].address,filtered[0].family);
  },callback);
}
dns.lookup=lookup;
dns.promises.lookup=(host,options={}) => new Promise((resolve,reject) => lookup(host,options,(err,address,family) => {
  if (err) reject(err);else resolve(options?.all ? address : {address,family});
}));
require('node:module').syncBuiltinESMExports();
