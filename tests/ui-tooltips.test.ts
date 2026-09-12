import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('native HTML hints use the shared tooltip; iframe accessible titles remain allowed', async () => {
  const violations: string[] = [];
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename);
      else if (entry.name.endsWith('.astro')) {
        const source = await readFile(filename, 'utf8');
        // Lowercase native tags only: Astro component title props are content.
        for (const match of source.matchAll(/<([a-z][\w-]*)\b[^<>]*?\stitle\s*=/g)) {
          if (match[1] !== 'iframe') violations.push(`${filename}: ${match[1]}`);
        }
      }
    }
  }
  await scan(fileURLToPath(new URL('../src/', import.meta.url)));
  assert.deepEqual(violations, []);
});
