import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const languageSwitcherPath = new URL('../src/components/LanguageSwitcher.astro', import.meta.url);
const designBriefPath = new URL('../.ui-craft/brief.md', import.meta.url);

test('language switcher reuses the navigation item visual system', async () => {
  const [languageSwitcher, designBrief] = await Promise.all([
    readFile(languageSwitcherPath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
  ]);

  assert.match(languageSwitcher, /class="nav-item language-switcher"/);
  assert.match(languageSwitcher, /class="nav-link language-switcher__trigger"/);
  assert.match(languageSwitcher, /class="nav-item-popover language-switcher__popover"/);
  assert.match(languageSwitcher, /class="nav-menu-item language-switcher__option"/);
  assert.doesNotMatch(languageSwitcher, /<select\b|<option\b/);

  const wrapperRule = languageSwitcher.match(/\.language-switcher\s*\{[\s\S]*?\n\s*\}/)?.[0];

  assert.doesNotMatch(wrapperRule ?? '', /border-left|padding-left/);
  assert.doesNotMatch(languageSwitcher, /outline:\s*1px solid var\(--border-strong\)/);
  assert.match(languageSwitcher, /role="menuitemradio"/);
  assert.match(languageSwitcher, /syncLocaleUI\(saved\)/);
  assert.doesNotMatch(languageSwitcher, /class="nav-menu-desc"/);
  assert.match(languageSwitcher, /min-width:\s*10\.5rem/);
  assert.match(designBrief, /语言切换器必须使用与“解决方案”“资源与服务”相同的导航下拉模式/);
  assert.match(designBrief, /紧凑变体.*10\.5rem/);
});
