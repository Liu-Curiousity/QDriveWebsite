import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const languageSwitcherPath = new URL('../src/components/LanguageSwitcher.astro', import.meta.url);
const siteHeaderPath = new URL('../src/components/SiteHeader.astro', import.meta.url);
const sharedStylesPath = new URL('../src/styles/site-shared.css', import.meta.url);
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

test('narrow navigation always exposes the mobile toggle and menu together', async () => {
  const [siteHeader, sharedStyles, languageSwitcher] = await Promise.all([
    readFile(siteHeaderPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
    readFile(languageSwitcherPath, 'utf8'),
  ]);

  assert.match(siteHeader, /@media \(max-width: 980px\)/);
  assert.match(languageSwitcher, /@media \(max-width: 980px\)/);

  const mobileNavRule = sharedStyles.match(/@media \(max-width: 980px\) \{[\s\S]*?\.site-nav-toggle[\s\S]*?header\.site-header nav[\s\S]*?\}/)?.[0] ?? '';
  assert.match(mobileNavRule, /\.site-nav-toggle/);
  assert.match(mobileNavRule, /header\.site-header nav/);
  assert.match(mobileNavRule, /display:\s*none/);
  assert.match(sharedStyles, /\.site-header\.is-nav-open nav\s*\{\s*display:\s*flex/);
  assert.match(sharedStyles, /header\.site-header \.nav-link[\s\S]*?padding:\s*\.6rem 1rem/);
  assert.match(sharedStyles, /\.nav-menu-item\s*\{\s*padding:\s*\.75rem 1rem/);
});

test('mobile header, frost surface and menu share one fixed positioning context', async () => {
  const [siteHeader, sharedStyles, designBrief] = await Promise.all([
    readFile(siteHeaderPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
    readFile(designBriefPath, 'utf8'),
  ]);

  assert.match(siteHeader, /<header class="site-header"[\s\S]*?<div class="site-header-frost"/);
  assert.doesNotMatch(siteHeader, /<div class="site-header-frost"[^>]*><\/div>\s*<header/);
  const frostRule = sharedStyles.match(/\.site-header-frost\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(frostRule, /position:\s*absolute/);
  assert.doesNotMatch(frostRule, /position:\s*fixed/);

  const mobileSection = sharedStyles.slice(sharedStyles.lastIndexOf('@media (max-width: 980px)'));
  assert.match(mobileSection, /header\.site-header,\s*body \.page header\.site-header\s*\{[^}]*position:\s*fixed/);
  assert.match(mobileSection, /\.page\s*\{\s*padding-top:\s*4\.5rem/);
  assert.match(mobileSection, /max-height:\s*calc\(100dvh - 4\.5rem\)/);
  assert.match(designBrief, /移动端页眉的导航内容、磨砂背景、阴影与展开菜单必须归属同一个固定容器/);
});
