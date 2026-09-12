import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postcss from 'postcss';

test('all web-host text fields and selectors share unlayered appearance and focus rules', async () => {
  const css = postcss.parse(await readFile(new URL('../src/styles/web-host-controls.css', import.meta.url), 'utf8'));
  const rules = css.nodes.filter((node) => node.type === 'rule');
  const base = rules.find((rule) => rule.selector.includes('.ctrl-value-row input') && rule.selector.endsWith(')'));
  assert.ok(base, 'input appearance must be defined outside the low-priority fallback layer');
  for (const selector of [
    '.ctrl-value-row input', '.config-pid-cell input', '.serial-assistant-field input',
    '.serial-assistant-quick-row input', '.serial-assistant-composer textarea',
    '.can-field input', '.can-search', '.serial-dd-trigger',
  ]) assert.ok(base.selector.includes(selector), `${selector} must use the common field appearance`);

  const declarations = (rule: postcss.Rule) => Object.fromEntries(
    rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
  );
  const normal = declarations(base);
  assert.equal(normal['text-align'], 'left');
  assert.equal(normal['border-radius'], 'var(--web-host-control-radius)');
  assert.equal(normal['font-size'], '0.8rem');
  assert.equal(normal.background, 'var(--bg-main)');
  assert.equal(normal.border, '1px solid var(--border-subtle)');

  const focus = rules.find((rule) => rule.selector === `${base.selector}:is(:focus-within, [aria-expanded='true'])`);
  assert.ok(focus, 'focus, search focus-within and expanded selectors must share the same state');
  assert.equal(declarations(focus)['border-color'], 'var(--accent)');
  assert.equal(declarations(focus)['box-shadow'], '0 0 0 3px var(--accent-soft)');

  css.walkRules((rule) => {
    if (!rule.selector.includes('input') && !rule.selector.includes('serial-dd-trigger-label')) return;
    rule.walkDecls('text-align', (declaration) => {
      assert.notEqual(declaration.value, 'center', `legacy centered input rule: ${rule.selector}`);
    });
  });
});

test('page-specific text-field rules contain layout only, without alternate appearance or focus patches', async () => {
  for (const file of ['serial-tool.css', 'serial-assistant.css', 'can-tool.css']) {
    const css = postcss.parse(await readFile(new URL(`../src/styles/${file}`, import.meta.url), 'utf8'));
    css.walkRules((rule) => {
      // The CAN inner search input is intentionally borderless; its outer .can-search owns the field.
      const field = /(?:\.ctrl-value-row input|\.config-pid-cell input|\.serial-assistant-field (?:input|select)|\.serial-assistant-quick-row input|\.serial-assistant-composer (?:textarea|select)|\.can-field input)/;
      if (!field.test(rule.selector) || rule.selector.includes('::placeholder') || rule.selector.includes('::-webkit-scrollbar')) return;
      rule.walkDecls((declaration) => {
        assert.ok(!/^(?:text-align|font(?:-.+)?|background(?:-.+)?|border(?:-.+)?|box-shadow|outline(?:-.+)?)$/.test(declaration.prop),
          `${file}: ${rule.selector} must not redefine ${declaration.prop}`);
      });
    });
  }
});
