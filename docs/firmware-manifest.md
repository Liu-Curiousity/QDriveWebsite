# 固件 Manifest 说明

固件列表只以运行时 manifest 作为数据源。Astro 页面只保留空的挂载点，不再写死任何固件版本、日期、说明或下载文件名。

- 固件数据放在 `/public/downloads/**/firmware/manifest.json`。部署后对应访问地址是 `/downloads/**/firmware/manifest.json`。
- `/public/downloads/` 已被 `.gitignore` 忽略，所以固件文件和真实 manifest 不进入 Git。它们需要由本地资产目录、服务器文件、对象存储或 CI/CD 流水线提供。
- 如果 manifest 文件缺失、网络失败或格式错误，弹窗里不会渲染固件条目；修复或替换服务器上的 manifest 后刷新页面即可恢复。

当前两个入口：

- QD4310：`/downloads/products/qd4310/firmware/manifest.json`
- QGimbal：`/downloads/solutions/qgimbal/firmware/manifest.json`

推荐 manifest 格式：

```json
{
  "baseUrl": "/downloads/products/qd4310/firmware/",
  "items": [
    {
      "version": "v6.2.3",
      "date": "2026-07-01",
      "file": "QD4310_V6.2.3.dfu",
      "latest": true,
      "size": 248320,
      "sha256": "replace-with-ci-generated-sha256",
      "notes": [
        "新增功能说明",
        "修复问题说明"
      ]
    }
  ]
}
```

CI/CD 发布新固件时建议执行：

1. 上传固件文件到对应 `firmware/` 目录。
2. 计算文件大小和 SHA-256。
3. 生成新的 `manifest.json`，将最新版本放在 `items` 第一项，并设置 `latest: true`。
4. 原子替换服务器上的 `manifest.json`。
5. 不需要重新编译 Astro 站点。
