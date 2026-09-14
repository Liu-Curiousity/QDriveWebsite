# 按钮样式维护

## 样式入口

| 用途 | 类名 / 入口 | 样式文件 |
| --- | --- | --- |
| 网站主操作 | `.btn-primary` | `src/styles/site-shared.css` |
| 产品、方案页的次操作链接 | `.pill-action` | `src/styles/site-shared.css` |
| 历史固件下载 | `.resource-download-action` | `src/styles/site-shared.css` |
| Motor / Gimbal 通用操作 | `.serial-btn`、`button.pill-action` | `src/styles/web-host-controls.css` |
| Serial / CAN 通用操作 | `.serial-assistant-primary` / `secondary`、`.can-primary` / `secondary` | `src/styles/web-host-controls.css` |

网站操作链接共享对齐、字体和文本修饰等基础属性，各变体直接声明自己的外观。固件下载按钮不再继承 `.pill-action` 的背景、边框、尺寸和悬停样式。

四个网页上位机先引入 `site-shared.css` 和工具专用样式，再引入 `web-host-controls.css`。通用按钮的基础、外观和交互规则集中维护；分裂按钮、图标开关等特殊控件，以及按钮行的布局仍由对应控件文件负责。

账号、管理后台、商城等组件的专用操作继续由各自 CSS 文件维护，不把它们的业务状态或特殊布局塞进全站按钮基础规则。

## 上位机主次按钮外观

主次按钮共用输入框高度 `--web-host-control-height` 和圆角 `--web-host-control-radius`，不使用胶囊圆角或阴影。悬停和按下仅改变背景色，不产生位移；键盘聚焦使用轮廓线。分裂按钮保留组合外框与内部分隔。

## 修改方式

- 修改已有按钮时，先定位表中的样式入口并修改现有规则，避免在文件末尾追加补丁。
- 新增外观明确不同的操作时，使用有用途含义的变体类，共享基础属性，不逐层覆盖整个按钮外观。
- 页面布局规则只控制排列、宽度和间距，通用按钮的内边距、字体、背景和交互归按钮样式维护。
- `web-host-normalization` 是低优先级默认层。未分层规则优先于该层，不要通过调整书写顺序来猜测生效值。
- 悬停提示继续遵循 `docs/ui-tooltips.md`，复用全站 `data-tooltip`。

整理样式后运行 `npm run check:styles`、`npm run check` 和 `npm run build`。涉及跨文件移动规则时，对照浏览器计算样式，覆盖普通、悬停、按下、键盘焦点及禁用状态，同时检查深浅主题、窄屏和语言差异。
