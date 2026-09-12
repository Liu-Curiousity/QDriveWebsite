# UI 提示规范

新增或修改悬停提示时，必须复用全站 tooltip：`src/scripts/assistant-tooltip.ts` 与 `src/styles/assistant-tooltip.css`。使用 `data-tooltip`，不要新增用于悬停提示的原生 `title` 属性，也不要复制 tooltip 样式或另建气泡组件。

表单保留 `required`、`type`、`min` 等约束，由共享逻辑统一展示校验提示；已有自定义校验的 `novalidate` 表单保留自己的校验逻辑。页面标题、组件标题参数、iframe 的无障碍标题不属于悬停提示，不应删除。使用方式和验证要求见 `docs/ui-tooltips.md`。
