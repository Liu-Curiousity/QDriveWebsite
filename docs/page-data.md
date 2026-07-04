# 页面运行时数据说明

产品页和方案页的资料下载列表、产品参数表使用运行时 JSON 作为数据源。Astro 页面只保留空挂载点，不再写死这些条目。

当前两个入口：

- QD4310：`/downloads/products/qd4310/page-data.json`
- QGimbal：`/downloads/solutions/qgimbal/page-data.json`

推荐结构：

```json
{
  "specifications": [
    { "label": "额定电压", "value": "7~26V" }
  ],
  "downloads": [
    {
      "type": "link",
      "icon": "📄",
      "title": "产品手册",
      "description": "PDF",
      "href": "/downloads/products/qd4310/QD4310使用手册.pdf",
      "target": "_blank",
      "rel": "noopener noreferrer"
    },
    {
      "type": "button",
      "id": "fw-open-btn",
      "icon": "🔧",
      "title": "历史固件",
      "description": "点击选择版本下载"
    }
  ],
  "thirdPartySolutions": [
    {
      "kicker": "VISION TRACKING",
      "title": "视觉目标跟踪方案",
      "description": "接入摄像头与上位机视觉算法，实现目标识别、云台跟随与实时姿态控制联动。",
      "image": "/images/solutions/qgimbal/qgimbal_right.png",
      "actionsLabel": "视觉目标跟踪方案链接",
      "actions": [
        { "label": "演示视频", "href": "https://example.com/video", "target": "_blank", "rel": "noopener noreferrer" },
        { "label": "方案源码", "href": "https://example.com/source", "target": "_blank", "rel": "noopener noreferrer" }
      ]
    }
  ],
  "linkLists": {
    "manuals": {
      "baseUrl": "/downloads/solutions/qgimbal/",
      "items": [
        { "file": "QGimbal使用手册.pdf", "title": "QGimbal 使用手册", "note": "PDF" }
      ]
    }
  }
}
```

`linkLists` 用于弹窗里的二级列表，例如 QGimbal 的产品手册和程序源码。没有二级列表的页面可以省略。

`thirdPartySolutions` 用于 QGimbal 等方案页的第三方方案卡片。`image` 填站内图片路径或完整 URL；`actions` 中的按钮支持 `href`、`file`、`target`、`rel`、`download`、`ariaLabel`。
