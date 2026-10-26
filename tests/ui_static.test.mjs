// Checks on the app's own source files that no browser is needed for. They guard rules that are easy to break by accident:
// the page is never built from text that could carry markup, every icon asked for exists, every import points at a real file,
// every style variable used is defined, and the security policy in index.html says what the privacy page says it does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_NAMES } from '../docs/js/ui/icons.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

function filesUnder(dir, extensions) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

const SCRIPTS = filesUnder(path.join(ROOT, 'js'), ['.js']);
const STYLES = filesUnder(path.join(ROOT, 'css'), ['.css']);
const relative = (file) => path.relative(ROOT, file);
/** The file's text with comments removed, so a comment that mentions a forbidden word does not count. */
function code(file) {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');
}

test('the source files exist', () => {
  assert.ok(SCRIPTS.length > 40, `found ${SCRIPTS.length} scripts`);
  assert.ok(STYLES.length >= 3, `found ${STYLES.length} style files`);
});

test('no script builds markup or runs text as code', () => {
  const forbidden = [
    [/\.innerHTML\b/, 'innerHTML'],
    [/\.outerHTML\b/, 'outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write(ln)?\b/, 'document.write'],
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
    [/\bsetInterval\s*\(\s*['"`]/, 'setInterval with a string'],
    [/\.setAttribute\(\s*['"]style['"]/, 'a style attribute written as text'],
    [/\.cssText\b/, 'cssText'],
    [/\bsrcdoc\b/, 'srcdoc'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bsendBeacon\b/, 'sendBeacon'],
    [/\bnew\s+WebSocket\b/, 'WebSocket'],
    [/\bnew\s+EventSource\b/, 'EventSource'],
  ];
  const problems = [];
  for (const file of SCRIPTS) {
    const text = code(file);
    for (const [pattern, name] of forbidden) {
      if (pattern.test(text)) problems.push(`${relative(file)}: ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the service worker is the only file allowed to fetch (when it exists)', () => {
  const worker = path.join(ROOT, 'sw.js');
  if (!fs.existsSync(worker)) return;
  const text = code(worker);
  // It may read from its own cache and from its own site, and nothing else.
  assert.ok(!/https?:\/\//.test(text), 'the service worker must not name an outside address');
});

test('every icon name used in the screens is drawn', () => {
  const names = new Set(ICON_NAMES);
  const patterns = [
    /\bicon\(\s*'([A-Za-z]+)'/g,
    /\bglyph:\s*'([A-Za-z]+)'/g,
    /\biconButton\(\s*'([A-Za-z]+)'/g,
    /\bicon:\s*'([A-Za-z]+)'/g,
    /\bglyph\s*=\s*'([A-Za-z]+)'/g,
  ];
  const missing = [];
  for (const file of filesUnder(path.join(ROOT, 'js', 'ui'), ['.js'])) {
    const text = code(file);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!names.has(match[1])) missing.push(`${relative(file)}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

/**
 * The arguments of every call of the browser's own append / prepend / before / after / replaceChildren in a file's text.
 * Returns [{ line, args: [text of each argument at the top level] }].
 */
function nativeInsertCalls(text) {
  const found = [];
  const start = /\.(append|prepend|before|after|replaceChildren)\(/g;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const args = [];
    let depth = 0;
    let quote = null;
    let current = '';
    let i = match.index + match[0].length;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (quote) {
        current += c;
        if (c === '\\') { current += text[i + 1]; i += 1; } else if (c === quote) quote = null;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') { quote = c; current += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (c === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
      current += c;
    }
    if (current.trim() !== '') args.push(current.trim());
    found.push({ line: text.slice(0, match.index).split('\n').length, args });
  }
  return found;
}

test('the browser\'s own append calls are never given something that can be empty', () => {
  // Element.append(null) puts the word "null" on the screen. h() and fill() leave empty children out; the browser's own calls do not.
  const risky = /(^|[^\w.$])(null|undefined|false)([^\w$]|$)|&&|\|\||\?\?/;
  const without = (arg) => arg.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const problems = [];
  for (const file of SCRIPTS) {
    for (const call of nativeInsertCalls(code(file))) {
      for (const arg of call.args) {
        // only what is at the top level of the argument counts; anything inside brackets belongs to a nested call
        let top = '';
        let depth = 0;
        for (const c of without(arg)) {
          if (c === '(' || c === '[' || c === '{') depth += 1;
          else if (c === ')' || c === ']' || c === '}') depth -= 1;
          else if (depth === 0) top += c;
        }
        if (risky.test(top)) problems.push(`${relative(file)}:${call.line}: ${arg.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every import points at a file that exists', () => {
  const problems = [];
  const pattern = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const file of SCRIPTS) {
    const text = code(file);
    for (const match of text.matchAll(pattern)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) problems.push(`${relative(file)} imports ${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every style variable that is used is defined somewhere', () => {
  const defined = new Set();
  const used = new Map();
  const sources = [...STYLES.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })), ...SCRIPTS.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
    // Set from a script: setProperty('--app-h', ...) or a style object with a '--name' key.
    for (const match of text.matchAll(/['"`](--[a-z0-9-]+)['"`]/g)) defined.add(match[1]);
    if (file.endsWith('.css')) {
      for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
        // A variable with a fallback in the same var() is allowed to be missing.
        if (!match[2] && !used.has(match[1])) used.set(match[1], relative(file));
      }
    }
  }
  const missing = [...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (in ${file})`);
  assert.deepEqual(missing, []);
});

test('index.html: the security policy blocks all network use and all outside code', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  assert.ok(meta, 'a Content-Security-Policy meta tag is present');
  const directives = Object.fromEntries(meta[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...values] = part.split(/\s+/);
    return [name, values.join(' ')];
  }));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['connect-src'], "'none'");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['style-src'], "'self'");
  assert.equal(directives['object-src'], "'none'");
  assert.equal(directives['frame-src'], "'none'");
  assert.equal(directives['form-action'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  assert.equal(directives['font-src'], "'none'");
  assert.equal(directives['media-src'], "'none'");
  for (const [name, value] of Object.entries(directives)) {
    assert.ok(!/https?:|\*|unsafe-/.test(value), `${name} must not allow outside addresses, wildcards or unsafe-*: ${value}`);
  }
});

test('index.html: no inline script, no inline style, no outside address', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'every script has a src');
  assert.ok(!/<style[\s>]/i.test(html), 'no <style> element');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler');
  const outside = html.match(/(?:href|src|action)\s*=\s*"(https?:)?\/\/[^"]*"/gi) || [];
  assert.deepEqual(outside, []);
});

test('style files name no outside address', () => {
  const problems = [];
  for (const file of STYLES) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/url\(\s*['"]?(https?:)?\/\//i.test(text) || /@import/i.test(text)) problems.push(relative(file));
  }
  assert.deepEqual(problems, []);
});
