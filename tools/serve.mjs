// A tiny web server for trying the app on your own computer. It needs nothing but Node:
//
//     node tools/serve.mjs            then open http://localhost:8080/
//
// The app is served at both / and /expenses-web/ (the address GitHub Pages gives it), so addresses behave the same
// way here as when it is published. Nothing is downloaded or uploaded; it only hands out the files in docs/.
//
// For the browser tests only (never needed to use the app):  node tools/serve.mjs --with-tests
// adds /__repo__/ which serves the whole project folder, so test pages can load the tests.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
export const BASE_PATH = '/expenses-web';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Finds the file for a request path inside `folder`, or null. Never leaves the folder. */
async function locate(folder, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(folder, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (candidate !== folder && !candidate.startsWith(folder + path.sep)) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      return (await stat(index)).isFile() ? index : null;
    }
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function startServer({ port = 8080, withTests = false, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let folder = DOCS;
    let pathname = url.pathname;
    if (withTests && pathname.startsWith('/__repo__/')) {
      folder = ROOT;
      pathname = pathname.slice('/__repo__'.length);
    } else if (pathname === BASE_PATH) {
      response.writeHead(301, { Location: `${BASE_PATH}/` });
      response.end();
      return;
    } else if (pathname.startsWith(`${BASE_PATH}/`)) {
      pathname = pathname.slice(BASE_PATH.length);
    }
    const file = request.method === 'GET' || request.method === 'HEAD' ? await locate(folder, pathname) : null;
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, port: address.port, url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${address.port}` });
    });
  });
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (runDirectly) {
  const args = process.argv.slice(2);
  const portArg = args.find((arg) => /^\d+$/.test(arg));
  const { url } = await startServer({ port: portArg ? Number(portArg) : 8080, withTests: args.includes('--with-tests') });
  console.log(`Serving the app at ${url}/ (and ${url}${BASE_PATH}/). Press Ctrl+C to stop.`);
}
