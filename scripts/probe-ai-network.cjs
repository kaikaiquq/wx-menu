// Public, unauthenticated connectivity checks. Does not read or send API keys.
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const targets = [
  ['openai-default', 'https://api.openai.com/v1/models', undefined],
  ['openai-ipv4', 'https://api.openai.com/v1/models', 4],
  ['control-tencent', 'https://cloud.tencent.com/', 4],
];
const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']);
async function probe([name, url, family, resolvedAddress]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timing = {};
    let phase = 'dns';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve({ name, phase, elapsedMs: Date.now() - started, timing, ...value });
    };
    const options = { agent: false, family };
    // Diagnostic only: preserve the official hostname, SNI and TLS verification.
    if (resolvedAddress && net.isIP(resolvedAddress)) {
      options.lookup = (_hostname, lookupOptions, callback) => {
        const addressFamily = net.isIP(resolvedAddress);
        if (lookupOptions && lookupOptions.all) callback(null, [{ address: resolvedAddress, family: addressFamily }]);
        else callback(null, resolvedAddress, addressFamily);
      };
      phase = 'tcp';
    }
    const request = https.get(url, options, (response) => {
      phase = 'response';
      timing.headersMs = Date.now() - started;
      finish({ httpStatus: response.statusCode, reachable: true });
      response.destroy();
      request.destroy();
    });
    const deadline = setTimeout(() => {
      finish({ reachable: false, networkCode: 'ETIMEDOUT' });
      request.destroy();
    }, 15000);
    request.on('socket', (socket) => {
      socket.once('lookup', (error, _address, addressFamily) => {
        if (done || error) return;
        timing.dnsMs = Date.now() - started;
        timing.addressFamily = addressFamily;
        phase = 'tcp';
      });
      socket.once('connect', () => { if (!done) { timing.tcpMs = Date.now() - started; phase = 'tls'; } });
      socket.once('secureConnect', () => { if (!done) { timing.tlsMs = Date.now() - started; phase = 'headers'; } });
    });
    request.on('error', (error) => finish({ reachable: false, networkCode: codes.has(error.code) ? error.code : 'NETWORK_ERROR' }));
  });
}
async function queryDNS(name, url) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ name, ...result });
    };
    const request = https.get(url, { headers: { Accept: 'application/dns-json' }, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 32768) { finish({ error: 'RESPONSE_TOO_LARGE' }); request.destroy(); }
      });
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          const addresses = (Array.isArray(result.Answer) ? result.Answer : [])
            .map(answer => answer.data).filter(address => typeof address === 'string' && net.isIP(address));
          finish({ httpStatus: response.statusCode, addresses });
        } catch { finish({ httpStatus: response.statusCode, error: 'INVALID_DNS_RESPONSE' }); }
      });
      response.on('error', () => finish({ error: 'NETWORK_ERROR' }));
    });
    const deadline = setTimeout(() => { finish({ error: 'ETIMEDOUT' }); request.destroy(); }, 15000);
    request.on('error', error => finish({ error: codes.has(error.code) ? error.code : 'NETWORK_ERROR' }));
  });
}
if (process.argv.includes('--dnspod-route')) {
  queryDNS('dnspod-doh', 'https://doh.pub/dns-query?name=api.openai.com&type=A').then(async result => {
    console.log(JSON.stringify(result));
    for (const address of (result.addresses || []).slice(0, 2)) {
      console.log(JSON.stringify(await probe(['openai-dnspod', 'https://api.openai.com/v1/models', 4, address])));
    }
  });
} else if (process.argv.includes('--dns')) {
  const local = dns.promises.lookup('api.openai.com', { all: true }).then(result => ({
    name: 'system-dns', addresses: result.map(item => item.address),
  })).catch(error => ({ name: 'system-dns', error: codes.has(error.code) ? error.code : 'NETWORK_ERROR' }));
  Promise.all([
    local,
    queryDNS('cloudflare-doh', 'https://cloudflare-dns.com/dns-query?name=api.openai.com&type=A'),
    queryDNS('google-doh', 'https://dns.google/resolve?name=api.openai.com&type=A'),
    queryDNS('dnspod-doh', 'https://doh.pub/dns-query?name=api.openai.com&type=A'),
  ]).then(results => results.forEach(result => console.log(JSON.stringify(result))));
} else {
  Promise.all(targets.map(probe)).then(results => results.forEach(result => console.log(JSON.stringify(result))));
}
