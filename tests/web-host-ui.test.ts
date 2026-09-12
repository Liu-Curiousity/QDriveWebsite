import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serialPagePath = new URL('../src/pages/tools/web-host/serial.astro', import.meta.url);
const canPagePath = new URL('../src/pages/tools/web-host/can.astro', import.meta.url);
const gimbalPagePath = new URL('../src/pages/tools/web-host/gimbal.astro', import.meta.url);
const sharedControlsPath = new URL('../src/styles/web-host-controls.css', import.meta.url);
const serialStylesPath = new URL('../src/styles/serial-assistant.css', import.meta.url);
const sharedSiteStylesPath = new URL('../src/styles/site-shared.css', import.meta.url);
const designSpecPath = new URL('../docs/web-host-design-system.md', import.meta.url);
const motorWaveformPath = new URL('../src/scripts/motor-waveform.ts', import.meta.url);
const motorPagePath = new URL('../src/pages/tools/web-host/motor.astro', import.meta.url);
const serialToolStylesPath = new URL('../src/styles/serial-tool.css', import.meta.url);
const canToolStylesPath = new URL('../src/styles/can-tool.css', import.meta.url);

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

test('gimbal axis tabs reproduce the reference bottom-line treatment', async () => {
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
    /\.page \.web-host-segmented-tabs\.gimbal-axis-switch\s*\{[^}]*\}/,
  )?.[0];
  const segmentedTabRule = sharedControls.match(
    /\.page \.web-host-segmented-tab\.gimbal-axis-switch__btn\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const activeLineRule = sharedControls.match(
    /\.page \.web-host-segmented-tab\.gimbal-axis-switch__btn::after\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.ok(segmentedTabsRule, 'shared segmented-tab rules must exist');
  assert.match(segmentedTabsRule, /border-bottom:\s*1px solid var\(--border-subtle\)/);
  assert.match(segmentedTabsRule, /background:\s*transparent/);
  assert.match(segmentedTabRule, /border-radius:\s*0/);
  assert.match(segmentedTabRule, /box-shadow:\s*none/);
  assert.match(activeLineRule, /height:\s*1px/);
  assert.match(activeLineRule, /background:\s*var\(--accent\)/);
  assert.match(designSpec, /分段标签/);
  assert.match(designSpec, /Gimbal 的 Yaw \/ Pitch 使用参考站底线式容器/);
});

test('web-host detail topbars share both content rails with their workspaces', async () => {
  const [sharedSiteStyles, sharedControls, designSpec] = await Promise.all([
    readFile(sharedSiteStylesPath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);

  const topbarRailRule = sharedSiteStyles.match(
    /\.serial-tool-topbar\s*\{[\s\S]*?\n\s*\}/g,
  )?.at(-1);

  assert.ok(topbarRailRule, 'the final shared topbar rail rule must exist');
  assert.match(topbarRailRule, /width:\s*100%/);
  assert.match(topbarRailRule, /margin-inline:\s*0/);
  const toolRailRule = sharedControls.match(
    /\.page :is\(\s*\.serial-tool-topbar,[\s\S]*?\.can-banner\s*\)\s*\{[^}]*\}/,
  )?.[0] ?? '';
  assert.match(toolRailRule, /width:\s*100%/);
  assert.match(toolRailRule, /max-width:\s*none/);
  assert.match(toolRailRule, /margin-inline:\s*0/);
  assert.match(designSpec, /标题栏必须占满 `main\.shell` 的内容宽度/);
  assert.match(designSpec, /左边线与导航栏 Logo 容器左边线重合/);
  assert.match(designSpec, /右边线与语言切换模块右边线重合/);
  assert.match(designSpec, /返回工具列表.*工具区右边线/);
});

test('web-host chooser reuses the download-center inward hover without reflow', async () => {
  const source = await readFile(new URL('../src/pages/tools/web-host/index.astro', import.meta.url), 'utf8');

  assert.match(source, /--web-host-hover-inset:\s*\.65rem/);
  assert.match(source, /hover \.panel-header > :is\(\.web-host-card-index, div\)[\s\S]*?translateX\(var\(--web-host-hover-inset\)\)/);
  assert.match(source, /hover \.web-host-card-arrow[\s\S]*?translateX\(calc\(-1 \* var\(--web-host-hover-inset\)\)\)/);
  assert.match(source, /\.sections--web-host a\.panel:hover\s*\{[\s\S]*?background:\s*transparent/);
  assert.doesNotMatch(source, /\.sections--web-host a\.panel:hover\s*\{[^}]*padding/);
});

test('dropdown list highlights keep equal insets and reference overflow behavior', async () => {
  const [sharedControls, dropdownController, designSystem] = await Promise.all([
    readFile(new URL('../src/styles/web-host-controls.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/scripts/serial-dropdown.ts', import.meta.url), 'utf8'),
    readFile(new URL('../docs/web-host-design-system.md', import.meta.url), 'utf8'),
  ]);
  const listboxRule = sharedControls.match(/\.page \.serial-dd-menu\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(listboxRule, /max-height:\s*min\(16rem, 52vh\)/);
  assert.match(listboxRule, /padding:\s*0\.4rem/);
  assert.match(listboxRule, /overflow-y:\s*auto/);
  assert.doesNotMatch(dropdownController, /syncDropdownEdgeSpacing|serial-dd-mirrored-gutter/);
  assert.match(designSystem, /下拉菜单与选项高光/);
  assert.match(designSystem, /只有内容超出时才在菜单内部滚动/);
  assert.match(designSystem, /上、下、左、右四边必须一致/);
  assert.match(designSystem, /可搜索选择器/);
});

test('motor waveform canvas inherits its workspace background', async () => {
  const [waveformController, designSystem] = await Promise.all([
    readFile(motorWaveformPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);

  assert.match(waveformController, /ctx\.clearRect\(0, 0, w, h\)/);
  assert.doesNotMatch(
    waveformController,
    /const plot = dark \? '#111111' : '#ffffff'/,
    'the waveform canvas must not paint a theme-specific rectangular backdrop',
  );
  assert.match(designSystem, /波形 Canvas 默认保持透明/);
  assert.match(designSystem, /终端、日志和数据表.*共享 surface token/);
});

test('device summary card keeps adjacent panel rails and equal inner whitespace', async () => {
  const [motorPage, gimbalPage, serialToolStyles, designSystem] = await Promise.all([
    readFile(motorPagePath, 'utf8'),
    readFile(gimbalPagePath, 'utf8'),
    readFile(serialToolStylesPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);

  assert.match(motorPage, /serial-side-block serial-side-block--device-summary/);
  assert.match(gimbalPage, /serial-side-block serial-side-block--device-summary/);
  const summaryRule = serialToolStyles.match(
    /\.serial-side-block--device-summary\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const fillButtonRule = serialToolStyles.match(
    /\.serial-btn-row--fill > button\s*\{[^}]*\}/,
  )?.[0] ?? '';
  assert.match(summaryRule, /width:\s*100%/);
  assert.match(summaryRule, /max-width:\s*100%/);
  assert.match(summaryRule, /align-self:\s*stretch/);
  assert.match(fillButtonRule, /flex:\s*1 1 auto/);
  assert.match(designSystem, /外框必须与同侧相邻面板共用左右基准线/);
  assert.match(designSystem, /不得通过收窄面板破坏纵向对齐/);
});

test('shared web-host buttons center their content consistently', async () => {
  const [sharedControls, designSystem] = await Promise.all([
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const sharedButtonRule = sharedControls.match(
    /\/\* Two button roles:[\s\S]*?\.page :is\([\s\S]*?\)\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.match(sharedButtonRule, /display:\s*inline-flex/);
  assert.match(sharedButtonRule, /align-items:\s*center/);
  assert.match(sharedButtonRule, /justify-content:\s*center/);
  assert.match(sharedButtonRule, /text-align:\s*center/);
  assert.doesNotMatch(sharedControls, /:is\(\.serial-btn, #serial-connect\.pill-action/);
  assert.match(sharedControls, /:where\(#serial-connect\.pill-action\)/);
  assert.match(designSystem, /按钮内容对齐/);
  assert.match(designSystem, /文字及“图标 \+ 文字”组合.*水平、垂直居中/);
  assert.match(designSystem, /下拉触发器.*标签靠左、箭头靠右/);
  assert.match(designSystem, /历史 ID 必须使用 `:where\(\)`/);
});

test('device and parameter action groups use reference content-width buttons', async () => {
  const [motorPage, gimbalPage, sharedControls, designSystem] = await Promise.all([
    readFile(motorPagePath, 'utf8'),
    readFile(gimbalPagePath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const motorFillRows = motorPage.match(/serial-btn-row serial-btn-row--fill/g) ?? [];
  const gimbalFillRows = gimbalPage.match(/serial-btn-row serial-btn-row--fill/g) ?? [];
  const referenceRows = sharedControls.match(
    /\.page \.serial-btn-row,[\s\S]*?\.page \.serial-btn-row\.serial-btn-row--equal\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const referenceButtons = sharedControls.match(
    /\.page \.serial-btn-row:is\(\.serial-btn-row--fill, \.serial-btn-row--equal\) > button\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.equal(motorFillRows.length, 2);
  assert.equal(gimbalFillRows.length, 2);
  assert.match(referenceRows, /display:\s*flex/);
  assert.match(referenceRows, /width:\s*auto/);
  assert.match(referenceRows, /flex-wrap:\s*wrap/);
  assert.match(referenceButtons, /width:\s*auto/);
  assert.match(referenceButtons, /flex:\s*0 0 auto/);
  assert.match(designSystem, /只保留兼容类名，不再强制按钮拉满或等宽/);
  assert.match(designSystem, /窄屏空间不足时整枚换行/);
});

test('web-host panels follow the reference task proportions and aligned numeric rows', async () => {
  const [canPage, serialToolStyles, sharedControls, designSystem] = await Promise.all([
    readFile(canPagePath, 'utf8'),
    readFile(serialToolStylesPath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const desktopColumns = serialToolStyles.match(/\.serial-layout\s*\{[^}]*\}/)?.[0] ?? '';
  const finalDesktopColumns = sharedControls.match(
    /@media \(min-width: 1101px\)\s*\{\s*\.page \.serial-layout\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const cardRailRule = sharedControls.match(
    /\.page \.serial-layout > :is\(\.serial-col-left, \.serial-col-right\),[\s\S]*?\{[^}]*\}/,
  )?.[0] ?? '';
  const communicationGrid = serialToolStyles.match(
    /\.config-pid-cells--communication\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const alignedParameterCell = serialToolStyles.match(
    /\.config-batch-row--fields-only \.config-pid-cell\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const compactParameterLabel = serialToolStyles.match(/\.config-pid-cell-label\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(desktopColumns, /minmax\(220px, 0\.9fr\) minmax\(0, 1\.45fr\) minmax\(260px, 1fr\)/);
  assert.match(finalDesktopColumns, /minmax\(220px, 17\.25rem\) minmax\(0, 1fr\) minmax\(260px, 19\.25rem\)/);
  assert.match(canPage, /class="can-sidebar"/);
  assert.doesNotMatch(canPage, /web-host-panel-group/);
  assert.doesNotMatch(sharedControls, /\.web-host-panel-group/);
  assert.match(cardRailRule, /inline-size:\s*100%/);
  assert.match(cardRailRule, /box-sizing:\s*border-box/);
  assert.match(communicationGrid, /grid-template-columns:\s*1fr 1fr 2fr/);
  assert.match(alignedParameterCell, /display:\s*grid/);
  assert.match(alignedParameterCell, /grid-template-rows:\s*minmax\(1\.35em, 1fr\) var\(--web-host-control-height\)/);
  assert.match(alignedParameterCell, /align-self:\s*stretch/);
  assert.match(compactParameterLabel, /font-size:\s*0\.68rem/);
  assert.match(compactParameterLabel, /white-space:\s*nowrap/);
  assert.match(designSystem, /边线、比例与数值对齐/);
  assert.match(designSystem, /左栏上限 `17\.25rem`/);
  assert.match(designSystem, /中间终端或波形区吸收外层轨道增加的空间/);
  assert.match(designSystem, /不使用贯穿整列的大外框/);
  assert.match(designSystem, /标签轨道与输入轨道各自对齐/);
  assert.match(designSystem, /不得让 `timeout\(s\)` 或 `uart\.baud_rate\(bps\)` 的孤立字符落到下一行/);
  assert.match(designSystem, /波特率属于需要快速扫描的参数值/);
});

test('serial preset rows share the card header rail without a scrollbar gutter', async () => {
  const [sharedControls, designSystem] = await Promise.all([
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const listRule = sharedControls.match(/\.page \.serial-assistant-quick-list\s*\{[^}]*\}/)?.[0] ?? '';
  const rowRule = sharedControls.match(/\.page \.serial-assistant-quick-row\s*\{[^}]*\}/)?.[0] ?? '';
  const webkitRule = sharedControls.match(
    /\.page \.serial-assistant-quick-list::\-webkit-scrollbar\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.match(listRule, /width:\s*100%/);
  // Check the gutter behavior, not legacy scrollbar sizes overridden by the base stylesheet.
  assert.match(listRule, /scrollbar-gutter:\s*auto/);
  assert.match(rowRule, /width:\s*100%/);
  assert.match(webkitRule, /display:\s*none/);
  assert.match(designSystem, /快捷发送等紧凑操作列表必须与标题栏共用左右内容基准线/);
  assert.match(designSystem, /不得为不存在的滚动条长期预留单侧空槽/);
});

test('split send button keeps one filled silhouette without an outer outline', async () => {
  const [sharedControls, serialStyles, serialToolStyles, designSystem] = await Promise.all([
    readFile(sharedControlsPath, 'utf8'),
    readFile(serialStylesPath, 'utf8'),
    readFile(serialToolStylesPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const wrapperRule = sharedControls.match(/\.page \.serial-assistant-send-split\s*\{[^}]*\}/)?.[0] ?? '';
  const childRule = sharedControls.match(
    /\.page \.serial-assistant-send-split > :is\(\.serial-assistant-send-main, \.serial-assistant-send-toggle\)\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const dividerRule = sharedControls.match(
    /\.page \.serial-assistant-send-split::after\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const toggleRule = sharedControls.match(
    /\.page \.serial-assistant-send-split > \.serial-assistant-send-toggle\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.match(wrapperRule, /overflow:\s*hidden/);
  assert.match(wrapperRule, /border:\s*0/);
  assert.match(wrapperRule, /border-radius:\s*var\(--web-host-control-radius\)/);
  assert.match(childRule, /border:\s*0/);
  assert.match(childRule, /border-radius:\s*0/);
  assert.match(childRule, /box-shadow:\s*none/);
  assert.match(sharedControls, /--web-host-split-divider-width:\s*1px/);
  assert.match(sharedControls, /--web-host-split-toggle-width:\s*var\(--web-host-control-height\)/);
  assert.match(sharedControls, /--web-host-split-chevron-size:\s*1\.15rem/);
  assert.match(dividerRule, /inset-inline-end:\s*var\(--web-host-split-toggle-width\)/);
  assert.match(dividerRule, /width:\s*var\(--web-host-split-divider-width\)/);
  assert.match(dividerRule, /background:\s*var\(--web-host-surface-panel\)/);
  assert.match(dividerRule, /pointer-events:\s*none/);
  assert.match(toggleRule, /flex:\s*0 0 var\(--web-host-split-toggle-width\)/);
  assert.match(toggleRule, /width:\s*var\(--web-host-split-toggle-width\)/);
  assert.match(toggleRule, /padding:\s*0/);
  assert.ok(sharedControls.indexOf(wrapperRule) < sharedControls.indexOf("@layer web-host-normalization {"));
  assert.match(childRule, /min-height:\s*var\(--web-host-control-height\)/);
  assert.match(serialStyles, /width:\s*var\(--web-host-split-chevron-size\)/);
  assert.match(serialStyles, /stroke-width:\s*2/);
  assert.doesNotMatch(serialStyles, /\.serial-assistant-send-toggle svg[^}]*translateX/);
  assert.match(serialStyles, /\[aria-expanded='true'\] svg\s*\{[^}]*rotate\(180deg\)/);
  assert.doesNotMatch(serialStyles, /\.serial-assistant-send-toggle\s*\{[^}]*border-left:/);
  assert.doesNotMatch(serialToolStyles, /\.serial-assistant-send-main/);
  assert.match(designSystem, /分裂按钮边界/);
  assert.match(designSystem, /不得绘制额外外轮廓/);
  assert.match(designSystem, /连接处必须保持直角/);
  assert.match(designSystem, /独立伪元素绘制/);
  assert.match(designSystem, /禁用透明度一并弱化/);
  assert.match(designSystem, /所在面板的背景色 token/);
  assert.match(designSystem, /当前为 1px/);
  assert.match(designSystem, /不得使用白色.*边框包围整个组合控件/);
  assert.match(designSystem, /接缝上下会出现双重亮边或残留圆角/);
  assert.match(designSystem, /`--web-host-split-chevron-size`/);
  assert.match(designSystem, /避免图标被 Flex 压缩/);
  assert.match(designSystem, /不得用单侧位移补偿/);
});

test('web-host surfaces reproduce the reference rounded elevation hierarchy', async () => {
  const [sharedControls, designSystem] = await Promise.all([
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const sidePanelRule = sharedControls.match(/\.page \.serial-side-block\s*\{[^}]*\}/)?.[0] ?? '';
  const terminalPanelRule = sharedControls.match(/\.page \.serial-terminal-card\s*\{[^}]*\}/)?.[0] ?? '';
  const assistantPanelRule = sharedControls.match(
    /\.page :is\(\.serial-assistant-card, \.serial-assistant-monitor, \.can-card, \.can-monitor\)\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.match(sharedControls, /Production-reference fidelity layer/);
  assert.match(sidePanelRule, /border:\s*0/);
  assert.match(sidePanelRule, /border-radius:\s*1rem/);
  assert.match(sidePanelRule, /box-shadow:\s*var\(--web-host-reference-card-shadow\)/);
  assert.match(terminalPanelRule, /border-radius:\s*1\.4rem/);
  assert.match(assistantPanelRule, /border-radius:\s*1rem/);
  assert.match(assistantPanelRule, /box-shadow:\s*var\(--web-host-reference-card-shadow\)/);
  assert.match(sharedControls, /border-radius:\s*999px/);
  assert.match(designSystem, /主要面板使用 `1rem` 圆角、无描边和两级轻投影/);
  assert.match(designSystem, /终端主面板使用 `1\.4rem` 圆角/);
});

test('motor and gimbal connection controls follow the reference flexible rows', async () => {
  const [motorPage, sharedControls, designSystem] = await Promise.all([
    readFile(motorPagePath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const toolbarRow = sharedControls.match(
    /\.page \.serial-col-left \.serial-toolbar\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const baudRows = sharedControls.match(
    /\.page \.serial-col-left \.serial-toolbar > :is\(\.serial-toolbar-baud, \.serial-status\)\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const baudField = sharedControls.match(
    /\.page \.serial-col-left \.serial-toolbar > \.serial-toolbar-baud\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const baudTrigger = sharedControls.match(
    /\.page \.serial-col-left \.serial-toolbar > \.serial-toolbar-baud \.serial-dd-trigger\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const equalActions = sharedControls.match(
    /\.page \.serial-btn-row:is\(\.serial-btn-row--fill, \.serial-btn-row--equal\) > button\s*\{[^}]*\}/,
  )?.[0] ?? '';

  assert.match(toolbarRow, /display:\s*flex/);
  assert.match(toolbarRow, /flex-wrap:\s*wrap/);
  assert.match(toolbarRow, /align-items:\s*center/);
  assert.match(baudRows, /grid-column:\s*auto/);
  assert.match(baudRows, /width:\s*auto/);
  assert.match(baudField, /flex:\s*0 0 auto/);
  assert.match(baudField, /white-space:\s*nowrap/);
  assert.match(baudTrigger, /width:\s*auto/);
  assert.match(baudTrigger, /min-width:\s*7\.5rem/);
  assert.match(motorPage, /serial-btn-row serial-btn-row--equal/);
  assert.match(equalActions, /flex:\s*0 0 auto/);
  assert.match(designSystem, /连接卡使用参考站的弹性行/);
  assert.match(designSystem, /不得为挤入更多按钮将“波特率”拆成两行/);
  assert.match(designSystem, /同级维护操作同样使用内容宽度/);
});

test('gimbal controls use the reference compact composition and retain status semantics', async () => {
  const [gimbalPage, sharedControls, designSystem] = await Promise.all([
    readFile(gimbalPagePath, 'utf8'),
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const actionBody = sharedControls.match(/\.page \.serial-gimbal-actions__body\s*\{[^}]*\}/)?.[0] ?? '';
  const actionRows = sharedControls.match(
    /\.page \.serial-gimbal-actions__left \.serial-btn-row\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const driveStates = sharedControls.match(/\.page \.serial-drive-states--gimbal\s*\{[^}]*\}/)?.[0] ?? '';
  const statusLabels = sharedControls.match(/\.page \.serial-drive-state-label\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(gimbalPage, /serial-drive-state-label">驱动</);
  assert.match(gimbalPage, /serial-drive-state-label">自稳</);
  assert.match(gimbalPage, /serial-drive-state-label">激光</);
  assert.match(actionBody, /display:\s*flex/);
  assert.match(actionBody, /flex-direction:\s*row/);
  assert.match(actionRows, /display:\s*flex/);
  assert.match(driveStates, /flex-direction:\s*column/);
  assert.match(driveStates, /align-items:\s*flex-start/);
  assert.match(statusLabels, /position:\s*absolute/);
  assert.match(statusLabels, /clip:\s*rect\(0 0 0 0\)/);
  assert.match(designSystem, /对象名称保留在 DOM 与无障碍描述中/);
});

test('can monitor toolbar uses stable horizontal tracks', async () => {
  const [canStyles, designSystem] = await Promise.all([
    readFile(canToolStylesPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const toolbar = canStyles.match(/\.can-monitor__toolbar\s*\{[^}]*\}/)?.[0] ?? '';
  const filters = canStyles.match(/\.can-filter-group\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(toolbar, /display:\s*grid/);
  assert.match(toolbar, /grid-template-columns:\s*max-content minmax\(0, 1fr\) auto/);
  assert.match(toolbar, /align-items:\s*center/);
  assert.match(filters, /display:\s*grid/);
  assert.match(filters, /grid-template-columns:\s*minmax\(8rem, 0\.85fr\) minmax\(10rem, 1\.15fr\) max-content max-content/);
  assert.match(canStyles, /@media \(max-width: 700px\)[\s\S]*?\.can-filter-group\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(designSystem, /标题 \/ 筛选控件 \/ 工具按钮.*三轨网格/);
});

test('all web-host primary panels follow the reference spacing rhythm', async () => {
  const [sharedControls, designSystem] = await Promise.all([
    readFile(sharedControlsPath, 'utf8'),
    readFile(designSpecPath, 'utf8'),
  ]);
  const workspace = sharedControls.match(/\.page \.serial-layout\s*\{[^}]*\}/)?.[0] ?? '';
  const motorColumns = sharedControls.match(
    /\.page :is\(\.serial-col-left, \.serial-col-right\)\s*\{[^}]*\}/,
  )?.[0] ?? '';
  const serialWorkspace = sharedControls.match(/\.page \.serial-assistant\s*\{[^}]*\}/)?.[0] ?? '';
  const serialSidebar = sharedControls.match(/\.page \.serial-assistant-sidebar\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(workspace, /max-width:\s*none/);
  assert.match(workspace, /margin-inline:\s*0/);
  assert.match(workspace, /gap:\s*1\.25rem/);
  assert.match(motorColumns, /gap:\s*1rem/);
  assert.match(serialWorkspace, /gap:\s*1rem/);
  assert.match(serialSidebar, /gap:\s*0\.85rem/);
  assert.match(designSystem, /Motor \/ Gimbal 主栅格横向间距固定为 `1\.25rem`/);
  assert.match(designSystem, /Serial \/ CAN 主区间距固定为 `1rem`/);
});


test('toolbar state and square sizing cannot be shadowed by normalization', async () => {
  const shared = await readFile(sharedControlsPath, 'utf8');
  const effective = shared.split('@layer web-host-normalization {')[0];
  assert.ok(effective.includes(".serial-assistant-option-toggle[aria-pressed='false']"));
  const toolbar = effective.match(/\.page :is\(\.serial-assistant-option-toggle, \.serial-assistant-mode-toggle\)\.serial-assistant-secondary\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(toolbar, /background:\s*var\(--accent-soft\)/);
  assert.match(toolbar, /border:\s*0/);
  assert.doesNotMatch(effective, /\.serial-assistant-option-toggle\[aria-pressed='true'\][^{]*\{[^}]*background:\s*var\(--text-main\)/);
  const square = effective.match(/\.page \.serial-assistant-option-toggle--icon\.serial-assistant-secondary\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(square, /width:\s*var\(--web-host-control-height\)/);
  assert.match(square, /flex:\s*0 0 var\(--web-host-control-height\)/);
  const serial = await readFile(serialStylesPath, 'utf8');
  assert.doesNotMatch(serial, /\.serial-assistant-toolbar-actions button[^}]*background:/);
  assert.doesNotMatch(serial, /\.serial-assistant-composer\.is-input-expanded \.serial-assistant-file-send\s*\{/);
});
