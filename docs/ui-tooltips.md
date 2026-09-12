# 全站 tooltip

全站使用原上位机 tooltip 的同一份外观与行为。`SiteHeader.astro` 初始化一次；Serial/CAN 的既有调用复用该实例。页面无需重复引入 CSS，也无需给动态新增的普通提示绑定事件。

```html
<button type="button" aria-label="下载日志" data-tooltip="下载日志">…</button>
<input type="number" data-tooltip="-1 表示无限发送" />
```

动态提示写入 `element.dataset.tooltip`。不要使用 `element.title` 或 `title="提示内容"`；运行时也会将遗留的原生标题提示迁移到共享 tooltip。iframe 的 `title`、文档 `<title>`、SVG `<title>`、组件的标题参数保留原有语义。

普通表单保留 HTML 校验约束。共享逻辑关闭原生提示 UI，在提交时执行 `checkValidity()`：无效提交被阻止，第一个无效字段获得焦点并显示同款 tooltip；有效提交继续进入原有处理逻辑。已有 `novalidate` 表单及 `formnovalidate` 提交按钮仍保持其原有约定。显式调用 `reportValidity()` 的无效提示同样由共享逻辑接管。

提示支持鼠标悬停、键盘焦点、Escape 关闭、动态元素及深浅主题；保留已有 `aria-describedby` 引用。弹窗内的提示挂载在对应 dialog 内，通过手动 popover 进入顶层，避免被弹窗遮挡或滚动容器裁剪。长文本可换行，不另建弹窗专用样式。

修改共享行为后，应验证普通页面与 dialog、桌面与窄屏、深浅主题、无效/有效提交、动态提示，以及 Serial 既有的即时校验提示。`tests/ui-tooltips.test.ts` 防止 Astro 原生元素重新引入标题悬停提示。
