// The files that let the app be added to the Home Screen and run offline: the manifest, the icons, the links in index.html, and the
// service worker (sw.js). These are static checks; the browser test tests/e2e/flows_offline.mjs runs the worker for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, rebuild } from '../tools/build_sw.mjs';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const text = (file) => readFile(path.join(DOCS, file), 'utf8');

/** Width and height of a PNG file, read from its header. */
async function pngSize(file) {
  const bytes = await readFile(path.join(DOCS, file));
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG file`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('the offline copy lists the files the app is made of, and its fingerprint is current', async () => {
  assert.equal(await rebuild(DOCS, { check: true }), true, 'docs/sw.js is out of date. Run: node tools/build_sw.mjs');
  const { files } = await fingerprint(DOCS);
  const listed = [...(await text('sw.js')).matchAll(/^ {2}'([^']+)',$/gm)].map((match) => match[1]);
  assert.deepEqual(listed, files, 'every file in docs/ except sw.js is listed, in order');
  for (const needed of ['index.html', 'manifest.webmanifest', 'js/ui/main.js', 'css/base.css', 'icons/icon-192.png', 'icons/apple-touch-icon.png']) {
    assert.ok(listed.includes(needed), `${needed} is kept for offline use`);
  }
});

test('the manifest describes a Home Screen app, and its icons exist at the sizes it claims', async () => {
  const manifest = JSON.parse(await text('manifest.webmanifest'));
  assert.equal(manifest.name, 'Expenses');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './', 'relative, so it works under /expenses-web/');
  assert.equal(manifest.scope, './');
  assert.match(manifest.background_color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(manifest.theme_color, /^#[0-9A-Fa-f]{6}$/);
  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(!/^(\/|[a-z]+:)/i.test(icon.src), `${icon.src} is a relative address`);
    const [width, height] = await pngSize(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} really is ${icon.sizes}`);
    sizes.add(icon.sizes);
  }
  assert.ok(sizes.has('192x192') && sizes.has('512x512'), 'both of the usual sizes are there');
  assert.deepEqual(await pngSize('icons/apple-touch-icon.png'), [180, 180], 'the iPhone Home Screen icon is 180 x 180');
});

test('index.html points at files that exist: manifest, icons, styles and the script', async () => {
  const html = await text('index.html');
  const targets = [...html.matchAll(/<(?:link|script)\b[^>]*?(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.includes('manifest.webmanifest') && targets.includes('icons/apple-touch-icon.png'), 'the Home Screen links are present');
  const known = new Set((await fingerprint(DOCS)).files);
  for (const target of targets) {
    assert.ok(!/^(\/|[a-z]+:)/i.test(target), `${target} is a relative address`);
    assert.ok(known.has(target), `${target} exists in docs/`);
  }
});

test('the offline copy only handles this site\'s own GET requests, never names another address, and never takes over a running app', async () => {
  const source = (await text('sw.js')).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'); // code, not comments
  assert.doesNotMatch(source, /https?:\/\//i, 'no web address in the worker');
  assert.doesNotMatch(source, /skipWaiting/, 'a new version waits for the app to be opened from scratch');
  assert.match(source, /request\.method !== 'GET'/, 'only GET requests are touched');
  assert.match(source, /origin !== self\.location\.origin/, 'only this site\'s own addresses are touched');
  assert.doesNotMatch(source, /cache\.put\([^)]*request/, 'nothing the person does is stored: only the listed files are');
  assert.doesNotMatch(source, /indexedDB|localStorage|postMessage|XMLHttpRequest|WebSocket|sendBeacon/, 'the worker has no way to read or send data');
});

test('docs/ holds only what is meant to be published', async () => {
  const names = await readdir(DOCS);
  // .nojekyll tells GitHub Pages to serve the folder as it is, without running it through Jekyll.
  assert.deepEqual(names.sort(), ['.nojekyll', 'css', 'icons', 'index.html', 'js', 'manifest.webmanifest', 'sw.js']);
});
