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

test('English home principles reserve separate tracks for labels, titles, and copy', async () => {
  const [homePage, designBrief] = await Promise.all([
    readFile(homePagePath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
  ]);

  const englishPrincipleRule = homePage.match(/:global\(html\[lang='en'\]\) \.principle\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const englishLabelRule = homePage.match(/:global\(html\[lang='en'\]\) \.principle > span\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.ok(englishPrincipleRule, 'the English principle layout rule must exist');
  assert.match(englishPrincipleRule, /grid-template-areas:\s*'label copy'\s*'title copy'/);
  assert.ok(englishLabelRule, 'the English principle label rule must exist');
  assert.match(englishLabelRule, /white-space:\s*normal/);
  assert.match(homePage, /grid-template-areas:\s*'label'\s*'title'\s*'copy'/);
  assert.match(designBrief, /分类与标题在左栏上下排列/);
  assert.match(designBrief, /640px 以下整体改为单栏/);
});

test('home journal follows the shared download-center ledger rhythm', async () => {
  const [homePage, designBrief] = await Promise.all([
    readFile(homePagePath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
  ]);

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
  assert.match(designBrief, /继续了解 QDrive.*产品下载中心相同的无卡片资源目录/);
});
