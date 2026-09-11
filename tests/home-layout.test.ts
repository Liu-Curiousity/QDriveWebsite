import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const homePagePath = new URL('../src/pages/index.astro', import.meta.url);

test('home product-stage metadata shares one left and right content rail', async () => {
  const homePage = await readFile(homePagePath, 'utf8');

  const stageTopRule = homePage.match(/\.stage-top\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.ok(stageTopRule, 'the product-stage metadata rule must exist');
  assert.match(stageTopRule, /left:\s*var\(--stage-content-gutter\)/);
  assert.match(stageTopRule, /right:\s*var\(--stage-content-gutter\)/);
  assert.doesNotMatch(stageTopRule, /right:\s*clamp\(/);
});

test('English home principles reserve separate tracks for labels, titles, and copy', async () => {
  const homePage = await readFile(homePagePath, 'utf8');

  const englishPrincipleRule = homePage.match(/:global\(html\[lang='en'\]\) \.principle\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const englishLabelRule = homePage.match(/:global\(html\[lang='en'\]\) \.principle > span\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.ok(englishPrincipleRule, 'the English principle layout rule must exist');
  assert.match(englishPrincipleRule, /grid-template-areas:\s*'label copy'\s*'title copy'/);
  assert.ok(englishLabelRule, 'the English principle label rule must exist');
  assert.match(englishLabelRule, /white-space:\s*normal/);
  assert.match(homePage, /grid-template-areas:\s*'label'\s*'title'\s*'copy'/);
});

test('home journal follows the shared download-center ledger rhythm', async () => {
  const homePage = await readFile(homePagePath, 'utf8');

  const journalHeadRule = homePage.match(/\.journal-head\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const journalLinkRule = homePage.match(/\.journal-link\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const journalTitleRule = homePage.match(/\.journal-link span\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const journalDescriptionRule = homePage.match(/\.journal-link strong\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.ok(journalHeadRule, 'the journal heading layout must exist');
  assert.match(journalHeadRule, /grid-template-columns:\s*minmax\(0, \.55fr\) minmax\(18rem, 1fr\)/);
  assert.match(journalHeadRule, /padding:\s*clamp\(2rem, 4vw, 3\.5rem\) 0/);
  assert.ok(journalLinkRule, 'the journal resource row must exist');
  assert.match(journalLinkRule, /grid-template-columns:\s*minmax\(0, \.55fr\) minmax\(18rem, 1fr\) auto/);
  assert.match(journalLinkRule, /padding:\s*1\.4rem 0/);
  assert.match(journalTitleRule ?? '', /font-size:\s*var\(--type-scale-body\)/);
  assert.match(journalDescriptionRule ?? '', /font-size:\s*var\(--type-scale-body\)/);
});
