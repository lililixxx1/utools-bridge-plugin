# 插件手机同步

一个 uTools 插件，让手机通过局域网访问 PC 端 uTools 的待办、笔记、剪贴板数据。**界面和数据由同一个 HTTP 服务提供**，手机访问一个地址即可使用。

## 工作原理

```
手机浏览器 ──局域网 WiFi──> 本插件(HTTP :3721)
                              ├── /          → PWA 手机界面
                              ├── /api/*     → REST 数据接口
                              └── (内部)      → uTools MCP 网关(127.0.0.1:3501)
```

uTools 的 MCP 服务只绑回环地址（`127.0.0.1:3501`），手机从 WiFi 物理上连不进来。本插件在中间做两层转换：
1. 作为 MCP 客户端连本地 3501（带 session 管理和断线重连）
2. 作为 HTTP 服务监听 `0.0.0.0:3721`，既服务 PWA 界面文件，又把 `/api/*` REST 请求翻译成 MCP 工具调用

**合并设计的好处**：PWA 和 API 同源，手机只需访问一个地址，无需配置，打开即用。

## 前置条件

**uTools 开启本地 MCP**：uTools 设置 → AI Agent 连接 → 启用 MCP。开启后会得到：
- 服务地址：`http://127.0.0.1:3501/mcp`
- 一个 `x-mcp-key`（每用户独有的本地密钥，属敏感数据）

> key 不在源码里硬编码。插件加载后，在控制台「MCP 配置」卡片把 uTools 设置里复制的配置 JSON 粘贴进去，点「应用」即可（持久保存，重启插件仍生效）。

## 安装与使用

1. 把整个 `utools-bridge-plugin` 目录拖入 uTools 开发者工具
2. 点「加载」
3. uTools 主搜索框输入「插件手机同步」打开控制台
4. 在「MCP 配置」卡片粘贴 uTools 设置里复制的配置 JSON，点「应用」
5. 点「启动桥接」
6. 手机（同一 WiFi）浏览器访问控制台显示的「访问地址」（已自动附带 `?key=xxx`，打开即用）
7. （可选）手机浏览器「添加到主屏幕」，当 App 用

## 访问密钥（鉴权）

出于安全考虑，插件**首次启动会自动生成一个随机访问密钥**并持久化，做到「开箱即鉴权」——避免局域网内任意网页读写你的剪贴板、笔记、待办。

- 控制台「访问地址」形如 `http://192.168.1.100:3721/?key=xxxx`，手机直接打开即可，PWA 加载后会自动把 key 存到本地并从地址栏抹掉。
- 之后 PWA 内所有 `/api` 调用都会自动带上 `x-bridge-key` 头。
- 想换密钥：点「换一个」重新生成。
- 想关闭鉴权（**有风险，仅建议完全自用的可信 WiFi 这样做**）：清空输入框点「保存」。此时同局域网内任意网页都能读写你的剪贴板（含密码）、笔记、待办。

服务端鉴权同时支持两种方式（二选一）：
- `x-bridge-key` 请求头 —— fetch 调用用
- `?key=` 查询参数 —— 浏览器导航请求（打开 PWA 页面）用

## 控制台功能

- **MCP 配置**：粘贴 uTools 设置里的配置 JSON（含 `x-mcp-key`，每用户独有敏感数据）
- **访问密钥**：管理随机密钥 / 换一个 / 关闭鉴权
- **连接信息**：局域网 IP、端口、访问地址（点击复制）、MCP 状态
- **最近请求**：实时显示手机端打来的请求日志

## 暴露的 REST 接口

统一响应：`{ ok: true, data: ... }` 或 `{ ok: false, error: "..." }`

| 方法 | 路径 | 对应 uTools 工具 | 说明 |
|---|---|---|---|
| GET | `/api/health` | — | 健康检查 |
| GET | `/api/todo/groups` | todo_group_list | 列出待办分组 |
| GET | `/api/todos?query=&group=&status=&dueAt=` | todo_search | 搜索待办 |
| POST | `/api/todos` body `{content,group?,dueAt?}` | todo_create | 创建待办 |
| PATCH | `/api/todos/:id` body `{patch:{...}}` | todo_update | 更新待办 |
| GET | `/api/notes?q=&limit=` | markdown_notes_search | 搜索笔记 |
| GET | `/api/notes/:id?format=text` | markdown_notes_get | 获取笔记 |
| POST | `/api/notes` body `{title,content}` | markdown_notes_create | 创建笔记 |
| GET | `/api/clipboard?query=&type=&limit=` | clipboard_history_search | 搜索剪贴板 |
| GET | `/api/clipboard/:id` | clipboard_history_get | 获取剪贴板条目 |
| POST | `/api/clipboard/copy` body `{type,text}` | clipboard_copy | 复制到剪贴板 |
| GET | `/api/clipboard/:id/blob` | clipboard_history_get + 文件流 | 图片字节流（`<img>` 缩略图/大图） |
| GET | `/api/clipboard/file?id=&path=` | clipboard_history_get + 文件流 | 下载 files 项里的指定文件 |
| POST | `/api/clipboard/upload` (multipart `file`) | 落盘 + clipboard_copy | 手机上传图片/小文件到 PC 剪贴板 |

> 字节路由（`:id/blob`、`/file`、`/upload`）不走 MCP —— MCP 工具对图片/文件只用 PC 本地路径，
> 没有字节。桥接层在拿到路径后用文件流直接传输。鉴权与其它 `/api/*` 一致（`x-bridge-key` 头或 `?key=`）；
> `<img src>` 和 `<a download>` 无法带请求头，因此用 `?key=` 拼 URL。
> 路径安全双闸：`:id/blob` 的图片路径必须在 uTools clipboard-data 目录内；`/file` 下载的 `path`
> 必须精确属于该 id 项的 files 数组 —— 任一不满足返回 403/400。
> 上传上限 20 MB，扩展名黑名单拦截可执行/脚本（`.exe/.bat/.ps1/.js/...`）。

## 数据结构（实测）

- 待办分组：`{groups:[{name:"今日"},...]}`
- 待办列表：`{tasks:[{id, text, group, completed:bool, created_at}]}` —— 字段是 `text`/`completed`，不是 `content`/`status`
- 待办更新：`patch:{status:"done"|"pending"}` —— 写入用 status，读取是 completed
- 剪贴板：`{items:[{id, type, timestamp, size, truncated?}], total}`，按 type 带不同字段：
  - `type:"text"` → 带 `text`（字符串）
  - `type:"image"` → 带 `image`（**PC 本地图片文件绝对路径**，非 base64）
  - `type:"files"` → 带 `files:[{name, path, type:"file"|"folder", exist}]`（**PC 本地路径数组**）

## 文件结构

```
utools-bridge-plugin/
├── plugin.json       uTools 插件清单
├── preload.js        核心：MCP 客户端 + HTTP 服务 + REST 路由 + 静态文件服务
├── index.html        PC 控制台 UI
├── logo.png
├── pwa/              手机端 PWA（由同一 HTTP 服务提供）
│   ├── index.html    全部 UI 和逻辑（内联 CSS/JS）
│   ├── manifest.json PWA 清单
│   ├── sw.js         service worker
│   └── icon-*.png    PWA 图标（192/512,any/maskable）
└── README.md
└── README.md
```
