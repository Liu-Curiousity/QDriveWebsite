import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const blogPagePath = new URL('../src/pages/blog.astro', import.meta.url);

test('blog index follows the shared download-center ledger rhythm', async () => {
  const blogPage = await readFile(blogPagePath, 'utf8');

  const indexHeaderRule = blogPage.match(/\.blog-index__header\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const topicRule = blogPage.match(/\.blog-topic\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const topicTitleRule = blogPage.match(/\.blog-topic h3\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const topicCopyRule = blogPage.match(/\.blog-topic p\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.match(indexHeaderRule ?? '', /grid-template-columns:\s*minmax\(0, \.55fr\) minmax\(18rem, 1fr\)/);
  assert.match(indexHeaderRule ?? '', /padding:\s*clamp\(2rem, 4vw, 3\.5rem\) 0/);
  assert.match(topicRule ?? '', /grid-template-columns:\s*minmax\(0, \.55fr\) minmax\(18rem, 1fr\) auto/);
  assert.match(topicRule ?? '', /padding:\s*1\.4rem 0/);
  assert.match(topicTitleRule ?? '', /font-size:\s*var\(--type-scale-body\)/);
  assert.match(topicTitleRule ?? '', /font-weight:\s*500/);
  assert.match(topicCopyRule ?? '', /font-size:\s*var\(--type-scale-body\)/);
  assert.match(topicCopyRule ?? '', /line-height:\s*1\.65/);
  assert.match(blogPage, /@media \(max-width: 640px\)[\s\S]*?\.blog-topic\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
});
