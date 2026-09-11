import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const headerPath = new URL('../src/components/SiteHeader.astro', import.meta.url);
const homePath = new URL('../src/pages/index.astro', import.meta.url);
const hostIndexPath = new URL('../src/pages/tools/web-host/index.astro', import.meta.url);
const sharedStylesPath = new URL('../src/styles/site-shared.css', import.meta.url);
const pageDataPath = new URL('../src/scripts/page-data.ts', import.meta.url);
const anniversaryComponentPath = new URL('../src/components/AnniversaryLottery.astro', import.meta.url);
const anniversaryStylesPath = new URL('../src/styles/anniversary-lottery.css', import.meta.url);

test('directional arrows follow destination semantics', async () => {
  const [header, home, hostIndex, sharedStyles, pageData, anniversaryComponent, anniversaryStyles] = await Promise.all([
    readFile(headerPath, 'utf8'),
    readFile(homePath, 'utf8'),
    readFile(hostIndexPath, 'utf8'),
    readFile(sharedStylesPath, 'utf8'),
    readFile(pageDataPath, 'utf8'),
    readFile(anniversaryComponentPath, 'utf8'),
    readFile(anniversaryStylesPath, 'utf8'),
  ]);

  assert.doesNotMatch(header, /nav-menu-arrow">↗/);
  assert.doesNotMatch(home, /href="\/(?:products|solutions|tools)\/[^\"]*"[^>]*>[\s\S]{0,180}↗/);
  assert.doesNotMatch(hostIndex, /web-host-card-arrow[^>]*>↗/);
  assert.match(anniversaryComponent, /活动暂未开放/);
  assert.match(anniversaryComponent, /<span aria-hidden="true">↗<\/span>/);
  assert.match(anniversaryStyles, /:disabled\s+span:last-child\s*\{\s*display:\s*none/);
  assert.match(sharedStyles, /\.page \.download-section \.download-card::after[\s\S]*?content:\s*'↓'/);
  assert.match(sharedStyles, /\.download-resource-dialog--resources \.resource-item--link::after[\s\S]*?content:\s*'→'/);
  assert.match(sharedStyles, /\.resource-item--download::after\s*\{\s*content:\s*'↓'/);
  assert.match(pageData, /resource-item--download/);
});
