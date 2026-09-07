import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentPath = new URL('../src/components/ResourceDialog.astro', import.meta.url);
const productPagePath = new URL('../src/pages/products/qd4310.astro', import.meta.url);
const solutionPagePath = new URL('../src/pages/solutions/qgimbal.astro', import.meta.url);
const sharedStylesPath = new URL('../src/styles/site-shared.css', import.meta.url);
const resourceScriptPath = new URL('../src/scripts/resource-dialog.ts', import.meta.url);
const designBriefPath = new URL('../.ui-craft/brief.md', import.meta.url);
const designTokensPath = new URL('../.ui-craft/tokens.md', import.meta.url);

test('download-center dialogs use one shared resource-dialog pattern', async () => {
  const [component, productPage, solutionPage, sharedStyles, designBrief, designTokens] = await Promise.all([
    readFile(componentPath, 'utf8'),
    readFile(productPagePath, 'utf8'),
    readFile(solutionPagePath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
    readFile(designTokensPath, 'utf8'),
  ]);

  assert.equal((productPage.match(/<ResourceDialog\b/g) ?? []).length, 1);
  assert.equal((solutionPage.match(/<ResourceDialog\b/g) ?? []).length, 3);
  assert.doesNotMatch(productPage, /<div class="resource-dialog-box/);
  assert.doesNotMatch(solutionPage, /<div class="resource-dialog-box/);

  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /aria-labelledby=\{titleId\}/);
  assert.match(component, /download-resource-dialog--\$\{variant\}/);
  assert.doesNotMatch(component, /kicker|RESOURCE LIBRARY|FIRMWARE ARCHIVE/);

  const sharedPattern = sharedStyles.match(
    /\/\* Shared download-resource dialog[\s\S]*$/,
  )?.[0];
  assert.ok(sharedPattern, 'shared download-resource dialog styles must exist');
  assert.match(sharedPattern, /border-radius:\s*12px/);
  assert.match(sharedPattern, /backdrop-filter:\s*none/);
  assert.match(sharedPattern, /width:\s*min\(92vw,\s*40rem\)/);
  assert.match(sharedPattern, /box-shadow:\s*none/);
  assert.match(sharedPattern, /transition:\s*opacity 160ms ease-out/);
  assert.match(sharedPattern, /resource-item--link:is\(:hover, :focus-visible\) :is\(\.resource-title, \.resource-note\)/);
  assert.match(sharedPattern, /prefers-reduced-motion/);
  assert.doesNotMatch(sharedPattern, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(sharedPattern, /translate(?:X|Y)?\(|scale\(/);

  assert.match(designBrief, /## 下载中心与资源弹窗规范/);
  assert.match(designBrief, /ResourceDialog\.astro/);
  assert.match(designBrief, /resources.*firmware/);
  assert.match(designBrief, /不增加英文分类眉题/);
  assert.match(designTokens, /石墨黑 58%/);
  assert.match(designTokens, /桌面端上限 640px/);
  assert.match(designTokens, /仅使用 160ms opacity/);
});

test('resource-dialog initialization and deferred focus are lifecycle-safe', async () => {
  const source = await readFile(resourceScriptPath, 'utf8');

  assert.match(source, /RESOURCE_DIALOGS_BOOTED_ATTRIBUTE/);
  assert.match(source, /document\.documentElement\.hasAttribute/);
  assert.match(source, /window\.cancelAnimationFrame\(focusFrame\)/);
  assert.match(source, /activeEntry !== entry/);
  assert.match(source, /aria-hidden.*false/);
});
