import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const defaultOutputPath = fileURLToPath(new URL('../dist/', import.meta.url));
const clientPath = fileURLToPath(new URL('./dev-client.js', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function respond(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(`${message}\n`);
}

export async function startDocsServer({
  port = process.env.PORT ?? '4174',
  outputPath = defaultOutputPath,
  dev,
} = {}) {
  if (!/^\d+$/.test(String(port)) || Number(port) > 65535 || (Number(port) < 1 && port !== 0)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const root = await realpath(outputPath).catch(error => {
    if (dev && error.code === 'ENOENT') return path.resolve(outputPath);
    throw error;
  });
  if (!dev && !(await stat(path.join(root, 'index.html'))).isFile()) {
    throw new Error('dist/index.html is missing. Run npm run build first.');
  }
  const client = dev ? await readFile(clientPath, 'utf8') : null;
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', dev ? 'no-store' : 'no-cache');
    let host;
    try {
      host = new URL(`http://${request.headers.host}`).hostname;
    } catch {}
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      respond(response, 403, 'Localhost requests only');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      respond(response, 405, 'Method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    } catch {
      respond(response, 400, 'Malformed URL');
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) {
      respond(response, 400, 'Invalid path');
      return;
    }
    if (pathname.startsWith('/__docs/')) {
      if (!dev) {
        respond(response, 404, 'Not found');
        return;
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        respond(response, 403, 'Same-origin requests only');
        return;
      }
      if (pathname === '/__docs/client.js') {
        response.writeHead(200, {
          'Content-Type': contentTypes['.js'],
          'Content-Length': Buffer.byteLength(client),
        });
        response.end(request.method === 'HEAD' ? undefined : client);
      } else if (pathname === '/__docs/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const send = state => {
          response.write(`event: ${state.error ? 'error' : 'built'}\ndata: ${JSON.stringify(state)}\n\n`);
        };
        // Subscribe before sending the snapshot so reconnects never miss a build.
        const unsubscribe = dev.subscribe(send);
        send(dev.getState());
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        response.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } else {
        respond(response, 404, 'Not found');
      }
      return;
    }
    // Mirror GitHub Pages' static-hosting behavior: a directory route works
    // both with and without a trailing slash (e.g. "/post" and "/post/" both
    // resolve to "/post/index.html") as long as there is no file extension.
    let routePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    if (!pathname.endsWith('/') && path.extname(pathname) === '') {
      const directIndex = path.resolve(root, `.${pathname}/index.html`);
      if (directIndex.startsWith(`${root}${path.sep}`)) {
        try {
          if ((await stat(directIndex)).isFile()) routePath = `${pathname}/index.html`;
        } catch {
          // No directory index for this path; fall through to the literal route.
        }
      }
    }
    const filename = path.resolve(root, `.${routePath}`);
    if (!filename.startsWith(`${root}${path.sep}`)) {
      respond(response, 403, 'Forbidden');
      return;
    }
    try {
      if (dev && path.extname(filename) === '.html') {
        // Capture before reading: an intervening publication may cause one extra
        // reload, but can never label old HTML with a newer generation.
        const state = dev.getState();
        let html;
        try {
          const resolved = await realpath(filename);
          if (!resolved.startsWith(`${root}${path.sep}`)) {
            respond(response, 403, 'Forbidden');
            return;
          }
          html = await readFile(resolved, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          html = '<!doctype html><html><head><meta charset="utf-8"><title>Documentation preview</title></head>' +
            '<body><h1>Documentation preview</h1><p>Waiting for a successful build. Fix the source and save to retry.</p></body></html>';
        }
        const script = `<script defer src="/__docs/client.js" data-generation="${encodeURIComponent(state.generation)}"></script>`;
        html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : html + script;
        response.writeHead(200, {
          'Content-Type': contentTypes['.html'],
          'Content-Length': Buffer.byteLength(html),
        });
        response.end(request.method === 'HEAD' ? undefined : html);
        return;
      }
      const resolved = await realpath(filename);
      if (!resolved.startsWith(`${root}${path.sep}`)) {
        respond(response, 403, 'Forbidden');
        return;
      }
      const file = await stat(resolved);
      if (!file.isFile()) {
        respond(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream',
        'Content-Length': file.size,
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(resolved), response);
    } catch (error) {
      if (response.headersSent) {
        console.error(`Failed to finish serving ${pathname}:`, error);
        response.destroy();
      } else if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        respond(response, 404, 'Not found');
      } else {
        console.error(`Failed to serve ${pathname}:`, error);
        respond(response, 500, 'Internal server error');
      }
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), 'localhost', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  let closing;
  return {
    server,
    port: server.address().port,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDocsServer().then(preview => {
    console.log(`Site preview available at http://localhost:${preview.port}`);
    console.log('Serving dist/ only. Press Ctrl+C to stop.');
    const stop = () => preview.close().catch(error => {
      console.error('Preview server shutdown failed:', error);
      process.exitCode = 1;
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => {
    console.error('Cannot start the preview server. Run npm run build first.', error);
    process.exitCode = 1;
  });
}
