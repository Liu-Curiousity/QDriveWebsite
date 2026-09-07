import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const homePagePath = new URL('../src/pages/index.astro', import.meta.url);
const designBriefPath = new URL('../.ui-craft/brief.md', import.meta.url);

test('home product-stage metadata shares one left and right content rail', async () => {
  const [homePage, designBrief] = await Promise.all([
    readFile(homePagePath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
  ]);

  const stageTopRule = homePage.match(/\.stage-top\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.ok(stageTopRule, 'the product-stage metadata rule must exist');
  assert.match(stageTopRule, /left:\s*var\(--stage-content-gutter\)/);
  assert.match(stageTopRule, /right:\s*var\(--stage-content-gutter\)/);
  assert.doesNotMatch(stageTopRule, /right:\s*clamp\(/);
  assert.match(designBrief, /FRONT \/ REAR PRODUCT VIEW/);
  assert.match(designBrief, /同一组左右内容基准线/);
});
