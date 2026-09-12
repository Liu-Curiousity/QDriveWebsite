import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const languageSwitcherPath = new URL('../src/components/LanguageSwitcher.astro', import.meta.url);
const siteHeaderPath = new URL('../src/components/SiteHeader.astro', import.meta.url);
const sharedStylesPath = new URL('../src/styles/site-shared.css', import.meta.url);
const homePagePath = new URL('../src/pages/index.astro', import.meta.url);

test('language switcher reuses the navigation item visual system', async () => {
  const languageSwitcher = await readFile(languageSwitcherPath, 'utf8');

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
});

test('narrow navigation always exposes the mobile toggle and menu together', async () => {
  const [siteHeader, sharedStyles, languageSwitcher] = await Promise.all([
    readFile(siteHeaderPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
    readFile(languageSwitcherPath, 'utf8'),
  ]);

  assert.match(siteHeader, /@media \(max-width: 980px\)/);
  assert.match(languageSwitcher, /@media \(max-width: 980px\)/);

  const mobileNavRule = sharedStyles.match(/@media \(max-width: 980px\) \{[\s\S]*?\.site-nav-toggle[\s\S]*?header\.site-header > nav[\s\S]*?\}/)?.[0] ?? '';
  assert.match(mobileNavRule, /\.site-nav-toggle/);
  assert.match(mobileNavRule, /header\.site-header > nav/);
  assert.match(mobileNavRule, /display:\s*none/);
  assert.match(sharedStyles, /\.site-header\.is-nav-open > nav\s*\{\s*display:\s*flex/);
  assert.match(sharedStyles, /header\.site-header \.nav-link[\s\S]*?padding:\s*\.6rem 1rem/);
  assert.match(sharedStyles, /\.nav-menu-item\s*\{\s*padding:\s*\.75rem 1rem/);
});

test('mobile header, frost surface and menu share one fixed positioning context', async () => {
  const [siteHeader, sharedStyles] = await Promise.all([
    readFile(siteHeaderPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
  ]);

  assert.match(siteHeader, /<header class="site-header"[\s\S]*?<div class="site-header-frost"/);
  assert.doesNotMatch(siteHeader, /<div class="site-header-frost"[^>]*><\/div>\s*<header/);
  const frostRule = sharedStyles.match(/\.site-header-frost\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(frostRule, /position:\s*absolute/);
  assert.doesNotMatch(frostRule, /position:\s*fixed/);

  // The landing-page exception is declared after the shared mobile block;
  // inspect the full stylesheet so both the shared fixed rule and exception
  // are covered by this regression test.
  const mobileSection = sharedStyles;
  assert.match(mobileSection, /header\.site-header,\s*body \.page header\.site-header\s*\{[^}]*position:\s*fixed/);
  assert.match(mobileSection, /\.page\s*\{\s*padding-top:\s*4\.5rem/);
  assert.match(mobileSection, /max-height:\s*calc\(100dvh - 4\.5rem\)/);
});

test('full-width navigation frost samples the page without a nested backdrop root', async () => {
  const [siteHeader, sharedStyles] = await Promise.all([
    readFile(siteHeaderPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
  ]);

  assert.doesNotMatch(siteHeader, /<header\b[^>]*data-reveal/);
  assert.equal(siteHeader.match(/class="site-header-frost"/g)?.length, 1);
  const frostRule = sharedStyles.match(/\.site-header-frost\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(frostRule, /position:\s*absolute/);
  assert.match(frostRule, /left:\s*calc\(50% - 50vw\)/);
  assert.match(frostRule, /right:\s*calc\(50% - 50vw\)/);
  const filterValue = frostRule.match(/backdrop-filter:\s*([^;]+);/)?.[1] ?? '';
  const filterToken = filterValue.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (filterToken) {
    assert.match(sharedStyles, new RegExp(`${filterToken}:\\s*blur\\(`));
  } else {
    assert.match(filterValue, /^blur\(/);
  }
  assert.match(frostRule, /pointer-events:\s*none/);

  for (const rule of sharedStyles.matchAll(/(?:^|\n)\s*header\.site-header\s*\{([^}]*)\}/g)) {
    for (const filter of rule[1].matchAll(/backdrop-filter:\s*([^;]+);/g)) {
      assert.equal(filter[1].trim(), 'none', 'Only the full-width frost may filter the page backdrop');
    }
  }

  const wrapperRule = sharedStyles.match(/body \.page > \.shell--header\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(wrapperRule, /padding-inline:\s*0/);
});

test('home navigation scrolls with the page while interior navigation stays sticky', async () => {
  const [homePage, sharedStyles] = await Promise.all([
    readFile(homePagePath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
  ]);

  assert.match(homePage, /<div class="page home-page"/);
  assert.match(sharedStyles, /\.page\.home-page > \.shell--header\.home-page-header\s*\{[\s\S]*?position:\s*relative/);
  const mobileHomeRule = sharedStyles.match(/\.page\.home-page\s*\{[^}]*padding-top:\s*0/)?.[0] ?? '';
  assert.match(mobileHomeRule, /padding-top:\s*0/);
  assert.match(sharedStyles, /\.page\.home-page > \.shell--header\.home-page-header > header\.site-header\s*\{[\s\S]*?position:\s*relative/);
  assert.match(sharedStyles, /body \.page > \.shell--header,\s*body \.page > main\.shell > header\.site-header\s*\{[\s\S]*?position:\s*sticky/);
});
