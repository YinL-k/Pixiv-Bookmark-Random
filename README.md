[English](README_en.md) | 中文

# Pixiv Bookmark Random

![Chrome](https://img.shields.io/badge/Chrome-Extension-blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-blueviolet)
![License](https://img.shields.io/badge/License-MIT-green)

一个基于 **Chrome Manifest V3** 的浏览器扩展：  
在 Pixiv 页面及原图直链页面（`i.pximg.net`）右下角注入 **Random** 按钮，用于跳转到随机收藏作品。

扩展在后台维护轻量缓冲队列，并在前端使用 `Image()` 进行预加载，以降低感知延迟。

---

## 主要特性

- 随机跳转至 Pixiv 收藏作品
- 兼容 Pixiv SPA 路由切换
- 后台缓冲 + 前端预加载
- 稳定的 tag 上下文与 recent 去重逻辑

---

## 设计与实现要点

### Tag 上下文管理
- 在无法解析 tag 的页面复用最近一次显式 tag 上下文  
- 仅在收藏列表页或 URL 明确携带 tag 时更新上下文

### Recent 去重策略
- 仅在**实际发生跳转**时记录 recent
- 预取、失败重试流程不会污染去重状态

### 稳定性优化
- `ensure()` 调用自动合并（coalesce）
- 按钮状态与 loading 提示统一渲染

---

## 安装方式

1. 打开 Chrome → `chrome://extensions`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目目录

---

## 免责声明

本项目 **与 Pixiv 官方无任何关联，也未获得 Pixiv Inc. 的认可或赞助**。  
Pixiv 及其相关商标均归其各自所有者所有。

本扩展：
- 不收集、上传、存储或传输任何用户数据  
- 不打包、重新分发、镜像或托管任何 Pixiv 内容  
- 所有逻辑均在**用户本地浏览器中运行**  
- 仅在用户已登录 Pixiv 的前提下，使用浏览器中现有的会话状态

部分功能（如在原图页面显示图片）可能会通过 **Declarative Net Request (DNR)**  
修改请求头（例如 `Referer` / `Origin`），以保证图片在浏览器中正常加载。

该行为：
- 不会绕过登录校验
- 不涉及内容下载或再分发
- 是否启用由用户自行决定

使用本软件即表示你理解并同意：
- 你需要自行确保使用行为符合 Pixiv 的用户协议及当地法律法规  
- 作者按“现状（AS IS）”提供本软件，不对任何直接或间接后果承担责任

---

## License

MIT License
