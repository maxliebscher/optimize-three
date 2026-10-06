// Minimal static server for the examples (no dependencies). Usage: node examples/serve.mjs [port]
// Serves the repository root so examples can import ../../skills/optimize-three/kit/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = +process.argv[2] || 5180;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm' };

createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.writeHead(302, { location: '/examples/basic/?perf' }).end(); return; }
    let p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { if (!res.headersSent) res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`http://localhost:${port}/examples/basic/?perf`));
