// Harness stand-in for ServiceApp's POST /wp-json/serviceapp/v1/vulns/match. Answers from
// /data/vulns.json ({ "<slug>": [ { id, cve, title, fixed_in } ] }), re-read on every request so a
// scenario can change it; any slug not listed is clean. Requires a Bearer token, like the real one.
const http = require('http');
const fs = require('fs');
http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || !req.url.startsWith('/wp-json/serviceapp/v1/vulns/match')) return send(404, { success: false });
  if (!/^Bearer \S+/.test(req.headers.authorization || '')) return send(401, { success: false });
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let vulns = {};
    try { vulns = JSON.parse(fs.readFileSync('/data/vulns.json', 'utf8')); } catch { /* none */ }
    let items;
    try { items = JSON.parse(raw).items; } catch { return send(400, { success: false }); }
    console.log(new Date().toISOString(), JSON.stringify(items));
    send(200, { success: true, feed: { lastSync: new Date().toISOString() },
      results: items.map((it) => ({ ...it, versionKnown: !!it.version, matches: vulns[it.slug] || [] })) });
  });
}).listen(8080);
