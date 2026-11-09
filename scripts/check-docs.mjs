import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const docs = readdirSync(new URL('docs/', root)).filter(name => name.endsWith('.md'));
const reference = docs.map(name => readFileSync(new URL(`docs/${name}`, root), 'utf8')).join('\n');
let count = 0;
for (const [file, object, prefix] of [['src/auth.ts', 'router', '/auth'], ['src/posts.ts', 'router', '/api/posts'], ['src/profiles.ts', 'router', '/api/profiles'], ['src/app.ts', 'app', '']]) {
  const source = readFileSync(new URL(file, root), 'utf8');
  const pattern = new RegExp(`${object}\\.(get|post|put|patch|delete)\\("([^"]+)"`, 'g');
  for (const match of source.matchAll(pattern)) {
    const path = prefix + (match[2] === '/' && prefix ? '' : match[2]);
    const route = `${match[1].toUpperCase()} ${path}`;
    assert.ok(reference.includes('`' + route + '`'), `Undocumented route: ${route}`);
    count++;
  }
}
for (const name of docs) {
  const source = readFileSync(new URL(`docs/${name}`, root), 'utf8');
  for (const match of source.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
    assert.ok(docs.includes(match[1]), `${name}: broken link ${match[1]}`);
  }
}
console.info(`Verified ${count} documented routes and local Markdown links.`);
