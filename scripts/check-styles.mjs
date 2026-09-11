import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';

// Only identical values in the same selector, importance and conditional scope
// are automatically removable. Different values require manual compatibility review.
export function redundantDeclarations(container) {
  const seen = new Set();
  const redundant = [];
  for (const node of [...(container.nodes ?? [])].reverse()) {
    if (node.type === 'atrule' && node.nodes) {
      if (!node.name.endsWith('keyframes')) redundant.push(...redundantDeclarations(node));
    } else if (node.type === 'rule') {
      // Nested selectors can depend on declarations in their enclosing rule.
      if (node.nodes.some((child) => !['decl', 'comment'].includes(child.type))) continue;
      for (const declaration of [...node.nodes].reverse()) {
        if (declaration.type !== 'decl') continue;
        const property = JSON.stringify([node.selector, declaration.prop, !!declaration.important]);
        const key = JSON.stringify([property, declaration.value]);
        if (seen.has(key)) redundant.push(declaration);
        seen.add(key);
      }
    }
  }
  return redundant;
}

async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(filename);
    else if (/\.(css|astro)$/.test(entry.name)) yield filename;
  }
}

async function main() {
  const fix = process.argv.includes('--fix');
  let count = 0;
  let blocks = 0;
  for await (const filename of sources(fileURLToPath(new URL('../src/', import.meta.url)))) {
    const source = await readFile(filename, 'utf8');
    const check = (css, offset = 0) => {
      blocks++;
      const root = postcss.parse(css, { from: filename });
      const redundant = redundantDeclarations(root);
      count += redundant.length;
      if (!fix) {
        for (const declaration of redundant) {
          console.error(`${path.relative(process.cwd(), filename)}:${declaration.source.start.line + offset}: redundant ${declaration.prop} in ${declaration.parent.selector}`);
        }
        return css;
      }
      for (const declaration of redundant) declaration.remove();
      root.walkRules((rule) => {
        if (rule.nodes.every((node) => node.type === 'comment')) rule.remove();
      });
      return root.toString();
    };
    const output = filename.endsWith('.css')
      ? check(source)
      : source.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_match, open, css, close, index) => {
        const offset = source.slice(0, index + open.length).split('\n').length - 1;
        return open + check(css, offset) + close;
      });
    if (fix && output !== source) await writeFile(filename, output);
  }
  console.log(`${blocks} style blocks checked; ${count} redundant declarations ${fix ? 'removed' : 'found'}.`);
  if (!fix && count) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
