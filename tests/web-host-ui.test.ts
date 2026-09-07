import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serialPagePath = new URL('../src/pages/tools/web-host/serial.astro', import.meta.url);
const gimbalPagePath = new URL('../src/pages/tools/web-host/gimbal.astro', import.meta.url);
const sharedControlsPath = new URL('../src/styles/web-host-controls.css', import.meta.url);
const serialStylesPath = new URL('../src/styles/serial-assistant.css', import.meta.url);
const designSpecPath = new URL('../docs/web-host-design-system.md', import.meta.url);

test('embedded dropdown triggers use the shared unframed combobox variant', async () => {
  const [serialPage, sharedControls, serialStyles] = await Promise.all([
    readFile(serialPagePath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(serialStylesPath, 'utf8'),
  ]);

  assert.match(serialPage, /serial-dd--combobox/);
  assert.match(serialPage, /serial-dd-trigger--embedded/);

  const embeddedTriggerRule = sharedControls.match(
    /\/\* Embedded combobox trigger[\s\S]*?\/\* Two button roles:/,
  )?.[0];

  assert.ok(embeddedTriggerRule, 'shared embedded-combobox rules must exist');
  assert.match(embeddedTriggerRule, /input:not\(\[type='hidden'\]\) \+ \.serial-dd-trigger/);
  assert.match(embeddedTriggerRule, /border:\s*0/);
  assert.match(embeddedTriggerRule, /background:\s*transparent/);
  assert.match(embeddedTriggerRule, /box-shadow:\s*none/);

  assert.doesNotMatch(
    serialStyles,
    /\.serial-assistant-combobox__toggle\.serial-dd-trigger\s*\{/,
    'embedded trigger styling must not drift back into a page-specific stylesheet',
  );
});

test('segmented tabs own their boundaries without container hairlines', async () => {
  const [gimbalPage, sharedControls, designSpec] = await Promise.all([
    readFile(gimbalPagePath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);

  assert.match(gimbalPage, /web-host-segmented-tabs gimbal-axis-switch/);
  assert.match(gimbalPage, /web-host-segmented-tab gimbal-axis-switch__btn/);
  assert.doesNotMatch(
    gimbalPage,
    /\.gimbal-axis-switch\s*\{[\s\S]*?background-image:\s*linear-gradient/,
    'page-specific tab containers must not draw decorative hairlines',
  );

  const segmentedTabsRule = sharedControls.match(
    /\/\* Segmented tabs[\s\S]*?\/\* Shared semantic state palette/,
  )?.[0];

  assert.ok(segmentedTabsRule, 'shared segmented-tab rules must exist');
  assert.match(segmentedTabsRule, /\.web-host-segmented-tabs\s*\{/);
  assert.match(segmentedTabsRule, /border:\s*0/);
  assert.match(segmentedTabsRule, /background-image:\s*none/);
  assert.match(segmentedTabsRule, /\.web-host-segmented-tabs::before/);
  assert.match(segmentedTabsRule, /content:\s*none/);
  assert.match(segmentedTabsRule, /\[aria-selected='true'\]/);
  assert.match(designSpec, /分段标签/);
  assert.match(designSpec, /禁止.*容器.*底线/);
});
