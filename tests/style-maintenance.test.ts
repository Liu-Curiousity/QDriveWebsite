import assert from 'node:assert/strict';
import test from 'node:test';
import postcss from 'postcss';
import { redundantDeclarations } from '../scripts/check-styles.mjs';

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
