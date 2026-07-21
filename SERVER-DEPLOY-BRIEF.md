# TapSulor Android 服务器更新接口部署说明

> 本文档交给负责服务器部署的 AI/运维同学，在 `https://ark.yanyususu.online/tapsulor/` 下部署更新接口。
> 客户端版本：**v1.0.1**（versionCode = 2），已实现「检查更新」功能：冷启动静默检查 + 设置面板手动按钮。

---

## 一、需要在服务器上做的事情

假设 nginx 站点根目录 `/tapsulor/` 对应路径为 `/var/www/tapsulor/`（按你实际路径替换），最终公网可访问：

```
https://ark.yanyususu.online/tapsulor/
├── version.json           ← 【必须】版本清单，客户端 GET 这个文件来判断更新
├── TapSulor-v1.0.1.apk    ← 【必须】最新 APK 安装包（随版本更新替换）
└── index.html             ← 【推荐】下载页（用户手动访问时看到的页面）
```

共 3 件事：
1. 把 APK 上传到该目录，命名为 `TapSulor-v1.0.1.apk`
2. 新建 `version.json`（内容见下方）
3. （可选）更新 `index.html` 让网页下载页显示最新版本和更新日志

---

## 二、version.json 字段规范（客户端按此解析）

客户端请求 `GET https://ark.yanyususu.online/tapsulor/version.json`，解析以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `latest_version` | string | 是 | 显示用版本号，如 `"1.0.1"` |
| `version_code` | integer | 是 | **整数版本号，用于比较**。客户端 `BuildConfig.VERSION_CODE` 小于此值才会弹更新。v1.0.1 对应 `2`。 |
| `apk_url` | string | 否 | APK 直链（完整 URL）。若存在，「立即更新」优先打开这个直链；没有则用 `download_page`。 |
| `download_page` | string | 否 | 下载页 URL（完整 URL）。如果没填 apk_url，就打开这个页面；都没填就打开站点根。 |
| `update_notes` | string | 否 | 更新日志（支持 `\n` 换行），会显示在弹窗正文里。 |
| `force_update` | boolean | 否 | 是否强制更新。`true` 时弹窗不可取消、没有「稍后」按钮，点完更新后退出 app。 |
| `published_at` | string | 否 | 发布时间字符串，会追加在日志下方显示。 |

### 本次 v1.0.1 的 `version.json` 内容（直接复制即可）

```json
{
  "latest_version": "1.0.1",
  "version_code": 2,
  "apk_url": "https://ark.yanyususu.online/tapsulor/TapSulor-v1.0.1.apk",
  "download_page": "https://ark.yanyususu.online/tapsulor/",
  "update_notes": "1. 修复微信/QQ 第三方登录在 WebView 内无法完成授权的问题（改用 Chrome Custom Tabs）\n2. 新增应用内检查更新：冷启动自动检查 + 设置面板手动按钮\n3. 发现新版本后弹窗提示，支持直接跳转下载",
  "force_update": false,
  "published_at": "2026-07-21"
}
```

> **注意 CORS / Content-Type**：nginx 默认会正确返回 `application/json`。如果有跨域问题，在 nginx 该 location 加 `add_header Access-Control-Allow-Origin *;`（客户端是 Android 原生 OkHttp，不跨域，通常不需要）。
> **注意缓存**：建议给 `version.json` 加 `Cache-Control: no-cache` 或短缓存（如 `max-age=60`），否则 CDN/浏览器缓存会导致新版本检测延迟。

### 后续发版流程（记一下）

每次发新版本时：
1. APK 改名为 `TapSulor-v{latest_version}.apk` 上传到同目录
2. 修改 `version.json` 的 4 个字段：`latest_version`、`version_code`（**必须 +1**）、`apk_url`、`update_notes`、`published_at`
3. 旧 APK 可保留也可删除，只要 `apk_url` 指向正确即可

---

## 三、APK 文件

- 本地路径：`/workspace/TapTapGain-Android/TapSulor-v1.0.1.apk`
- 大小：10,815,848 字节（约 10.3 MB）
- SHA256：`3d088f07409246b6ae56042b33de138455d278ce7e4090ed4e6612eace5ac598`
- 上传后公网地址应为：`https://ark.yanyususu.online/tapsulor/TapSulor-v1.0.1.apk`

请把该 APK 放到 nginx 站点目录下，文件名保持 `TapSulor-v1.0.1.apk` 不变（与 version.json 中 apk_url 对应）。

---

## 四、index.html 下载页（推荐更新）

如果想让用户在浏览器里访问 `https://ark.yanyususu.online/tapsulor/` 看到一个像样的下载页，可以把下面的 HTML 保存为 `index.html`（如果原来已有该文件，可在此基础上合并）。它会自动读取 `version.json` 显示最新版本号和更新日志，并提供一个「下载 APK」大按钮：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>TapSulor 下载</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #1a1d29 0%, #252a3a 100%);
    color: #e8eaed; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    width: 100%; max-width: 480px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px; padding: 32px 28px; backdrop-filter: blur(10px);
  }
  .logo { font-size: 48px; text-align: center; margin-bottom: 8px; }
  h1 { text-align: center; font-size: 24px; margin-bottom: 4px; }
  .version {
    text-align: center; color: #25B6E9; font-size: 14px; margin-bottom: 24px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .desc { text-align: center; color: #9aa0a6; font-size: 14px; line-height: 1.6; margin-bottom: 28px; }
  .download-btn {
    display: block; width: 100%; padding: 16px; border: none; border-radius: 12px;
    background: linear-gradient(135deg, #25B6E9 0%, #1E96BF 100%);
    color: #fff; font-size: 17px; font-weight: 600; cursor: pointer;
    text-decoration: none; text-align: center; transition: transform 0.1s;
  }
  .download-btn:hover { transform: translateY(-1px); }
  .download-btn:active { transform: translateY(0); }
  .notes {
    margin-top: 24px; padding: 16px; background: rgba(0,0,0,0.2);
    border-radius: 10px; font-size: 13px; line-height: 1.8; color: #c5cad1;
    white-space: pre-wrap;
  }
  .notes-title { font-size: 12px; color: #7a808a; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #5f6368; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">📊</div>
  <h1>TapSulor</h1>
  <div class="version" id="version">加载中...</div>
  <p class="desc">TapTap 开发者数据看板（非官方）<br>第三方登录 · 多工作室切换 · 实时数据</p>
  <a class="download-btn" id="btn" href="#">下载最新版 APK</a>
  <div class="notes">
    <div class="notes-title">更新日志</div>
    <div id="notes">加载中...</div>
  </div>
  <div class="footer" id="published"></div>
</div>
<script>
fetch('version.json?ts=' + Date.now())
  .then(r => r.json())
  .then(info => {
    document.getElementById('version').textContent = 'v' + (info.latest_version || '?') + '  ·  versionCode ' + (info.version_code || '?');
    document.getElementById('notes').textContent = info.update_notes || '—';
    if (info.published_at) document.getElementById('published').textContent = '发布于 ' + info.published_at;
    const href = info.apk_url || info.download_page || '#';
    document.getElementById('btn').href = href;
  })
  .catch(() => {
    document.getElementById('version').textContent = '';
    document.getElementById('notes').textContent = '加载失败，请刷新重试';
  });
</script>
</body>
</html>
```

这个页面**自适应**手机和 PC，会自动拉 `version.json` 渲染版本号/日志，所以以后只需要改 `version.json` + 替换 APK，网页无需再改。

---

## 五、nginx 可选优化片段

如果服务器 nginx 还没配过，最小可用配置：

```nginx
server {
    listen 443 ssl http2;
    server_name ark.yanyususu.online;
    # ... ssl 证书配置略（已存在）...

    location /tapsulor/ {
        alias /var/www/tapsulor/;
        index index.html;
        autoindex off;

        # 让 version.json 不被长时间缓存，保证及时发现新版本
        location ~* /tapsulor/version\.json$ {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Access-Control-Allow-Origin "*";
        }
    }
}
```

---

## 六、部署完成后的验证步骤

部署后**用浏览器**依次访问，确认能拿到正确内容：

1. `https://ark.yanyususu.online/tapsulor/version.json` —— 应返回上面那份 JSON
2. `https://ark.yanyususu.online/tapsulor/TapSulor-v1.0.1.apk` —— 应开始下载 APK（约 10.3 MB）
3. `https://ark.yanyususu.online/tapsulor/` —— 应显示下载页，版本号 v1.0.1

通过后，在 App（v1.0.1）的「设置 → 系统信息 → 检查更新」点按钮，应弹「已是最新版本」。
等下次发 v1.0.2（version_code=3）时，把 version.json 的 version_code 改成 3，再打开 App 就会弹更新对话框。

---

## 七、客户端是怎么工作的（供你参考，无需改）

- 冷启动 3 秒后**静默**请求一次 `version.json`，发现新版本才弹对话框，失败/已是最新都不打扰用户
- 用户在设置面板点「检查更新」会**手动**触发，此时已是最新/失败都会 Toast 提示
- 比较方式：`version_code`（整数） > `BuildConfig.VERSION_CODE` 才弹更新，比字符串比较可靠
- 「立即更新」优先用 Chrome Custom Tabs 打开 apk_url（直接下载），没有 Custom Tabs 就降级为系统浏览器 ACTION_VIEW
- 若 `force_update=true`：弹窗不可取消，点完更新后直接 `finishAffinity()` 退出 App，强制用户升级
