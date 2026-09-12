import assert from 'node:assert/strict';
import test from 'node:test';
import postcss from 'postcss';
import { redundantDeclarations, repeatedSelectorBlocks } from '../scripts/check-styles.mjs';

test('selector review finds separated blocks without combining conditional scopes', () => {
  const root = postcss.parse(`
    .card { padding: 1rem; }
    .other { color: red; }
    .card { color: blue; }
    .card:hover { color: green; }
    @media (max-width: 600px) { .card { padding: 0; } }
    @media (prefers-color-scheme: dark) { .card { color: white; } }
    @layer variants {
      .card { border: 0; }
      .card { border-radius: 1rem; }
    }
    @keyframes pulse { from { opacity: 0; } from { opacity: 1; } }
  `);
  const before = root.toString();
  const groups = repeatedSelectorBlocks(root);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((rules: Array<{ selector: string }>) => rules.length === 2 && rules[0].selector === '.card'));
  assert.equal(root.toString(), before);
});

test('style cleanup preserves fallback syntax and conditional boundaries', () => {
  const root = postcss.parse(`
    .card { width: 100%; width: min(100%, 30rem); }
    .card { display: block; display: -vendor-layout; }
    .other { display: block; display: 0; }
    @media (max-width: 600px) { .card { width: 100%; } }
    @supports (display: grid) { .card { display: grid; } }
    @keyframes pulse { from { opacity: 0; } to { opacity: 0; } }
  `);
  assert.equal(redundantDeclarations(root).length, 0);
});

test('style cleanup removes earlier overrides without moving later rules', () => {
  const root = postcss.parse(`
    .card { padding: 1rem; color: var(--text-main); }
    .card { padding-left: 3rem; }
    .card { padding: 1rem; color: var(--text-main); }
  `);
  const redundant = redundantDeclarations(root);
  assert.deepEqual(redundant.map((node: { prop: string }) => node.prop).sort(), ['color', 'padding']);
  assert.ok(redundant.every((node: { parent: unknown }) => node.parent === root.first));
});

test('style cleanup preserves importance, custom property fallbacks and selector specificity', () => {
  const root = postcss.parse(`
    .card { color: transparent !important; --surface: red; }
    .card { color: currentColor; --surface: blue; }
    .page .card { color: transparent !important; }
    :where(.card) { color: currentColor; }
  `);
  assert.equal(redundantDeclarations(root).length, 0);
});
