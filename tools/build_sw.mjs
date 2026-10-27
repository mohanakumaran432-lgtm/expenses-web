// Writes the fingerprint and the file list into docs/sw.js, so the offline copy always matches the app's files.
//
//     node tools/build_sw.mjs            rewrites docs/sw.js (run it after changing anything in docs/)
//     node tools/build_sw.mjs --check    exits with 1 if docs/sw.js is out of date (the unit tests run the same check)
//
// The fingerprint covers every file's name and bytes plus the worker's own code, so any change to the app gives the offline copy a
// new name, and the browser then downloads the new version in the background.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BEGIN = '// BEGIN GENERATED (node tools/build_sw.mjs)';
const END = '// END GENERATED';
const DEFAULT_DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

async function listFiles(folder, base = folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

/** The worker's own code, without the generated part: { head, tail }. */
function splitWorker(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error('sw.js has lost its BEGIN GENERATED / END GENERATED lines');
  return { head: text.slice(0, start), tail: text.slice(end + END.length) };
}

/** { version, files }: every file the app is made of except sw.js, and a fingerprint of their names and bytes plus the worker's code. */
export async function fingerprint(docsDir = DEFAULT_DOCS) {
  const files = (await listFiles(docsDir)).filter((file) => file !== 'sw.js').sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(docsDir, file)));
    hash.update('\0');
  }
  const { head, tail } = splitWorker(await readFile(path.join(docsDir, 'sw.js'), 'utf8'));
  hash.update(head);
  hash.update(tail);
  return { version: hash.digest('hex').slice(0, 12), files };
}

function generatedBlock({ version, files }) {
  return `${BEGIN}\nconst VERSION = '${version}';\nconst FILES = [\n${files.map((file) => `  '${file}',`).join('\n')}\n];\n${END}`;
}

/** Rewrites sw.js (or, with check, only says whether it is already right). */
export async function rebuild(docsDir = DEFAULT_DOCS, { check = false } = {}) {
  const file = path.join(docsDir, 'sw.js');
  const text = await readFile(file, 'utf8');
  const { head, tail } = splitWorker(text);
  const next = `${head}${generatedBlock(await fingerprint(docsDir))}${tail}`;
  if (check) return next === text;
  if (next !== text) await writeFile(file, next);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const folder = args.find((arg) => !arg.startsWith('--'));
  const ok = await rebuild(folder ? path.resolve(folder) : DEFAULT_DOCS, { check });
  if (check && !ok) {
    console.error('docs/sw.js is out of date. Run: node tools/build_sw.mjs');
    process.exit(1);
  }
  console.log(check ? 'docs/sw.js is up to date' : 'docs/sw.js written');
}
