// preload.js — Node 层（CommonJS）
// 职责：在 uTools 插件进程内起一个 HTTP 服务，把 uTools 的 MCP 网关
//       （127.0.0.1:3501，仅回环）转换成简单 REST，暴露到局域网供手机访问。
//
// 为什么需要这一层：
// uTools 的 MCP 服务只监听 127.0.0.1，手机从 WiFi 物理上连不进来。
// 而手机端实现完整 MCP 客户端（SSE + JSON-RPC 握手）成本太高、对数据型应用也过度。
// 所以本插件做两件事：
//   1. 作为 MCP 客户端连本地 3501（带 session 管理和断线重连）
//   2. 作为 HTTP 服务监听 0.0.0.0，把 REST 请求翻译成对应 MCP tool 调用
// 手机端只写普通 fetch 即可。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
// clipboard 用于「从剪贴板导入」读文本。uTools 文档只提供了写剪贴板的 copyText，
// 没有公开读剪贴板的 API；按文档「引入 Electron 渲染进程 API」一节的标准做法用 electron.clipboard。
let electronClipboard;
try { electronClipboard = require('electron').clipboard; } catch (e) { /* 非 uTools 环境无 electron */ }

// ─── 设备隔离存储 ───────────────────────────────────────────────────
// dbStorage 默认会随用户开启云同步而备份到云端 + 多设备秒级同步。
// 但本插件的 MCP key（仅对本机 127.0.0.1:3501 有效）和 bridge-key
// 都只与「当前设备」相关，同步到其他设备纯属多余扩散，且多设备并发写
// 还会触发 db 文档冲突。文档提供的 utools.getNativeId() 正是为「只与
// 当前设备相关的信息」设计的。这里给敏感配置加 nativeId 前缀做设备隔离。
//
// 同时做向后兼容迁移：老版本用裸 key 名（'mcp-config' / 'bridge-key'），
// 首次读到新 key 为空而老 key 有值时，搬过来并删老 key，老用户升级不丢配置。
function nativeId() {
    try { return utools.getNativeId && utools.getNativeId(); } catch (e) { return ''; }
}
// 记录已迁移过的裸 key，避免每次都去探
const _migrated = new Set();
function storeKey(name) {
    const nid = nativeId();
    return nid ? nid + '/' + name : name; // getNativeId 不可用时退回裸名（不阻断功能）
}
function storeGet(name) {
    const nid = nativeId();
    const nk = storeKey(name);
    try {
        let v = utools.dbStorage.getItem(nk);
        // 迁移：仅当启用了设备隔离(nid 非空)、新 key 没值、且本次还没迁移过时,
        // 从老裸 key 搬一份过来并删除老 key。老用户升级后配置不丢。
        if (nid && (v === null || v === undefined) && !_migrated.has(name)) {
            const legacy = utools.dbStorage.getItem(name);
            if (legacy !== null && legacy !== undefined) {
                utools.dbStorage.setItem(nk, legacy);
                utools.dbStorage.removeItem(name);
                v = legacy;
            }
            _migrated.add(name);
        }
        return v;
    } catch (e) { return null; }
}
function storeSet(name, val) {
    try { utools.dbStorage.setItem(storeKey(name), val); } catch (e) {}
}
function storeDel(name) {
    try { utools.dbStorage.removeItem(storeKey(name)); } catch (e) {}
}

// ─── 配置 ───────────────────────────────────────────────────────────
// MCP 网关地址。固定回环地址，uTools 本地 MCP 服务默认就监听这里。
const MCP_DEFAULT_URL = 'http://127.0.0.1:3501/mcp';
// MCP 网关的 x-mcp-key 是每用户独有密钥（uTools 开启本地 MCP 时生成），
// 属敏感数据，绝不硬编码在源码里。默认为空，首次使用需在「MCP 配置」
// 卡片把 uTools 设置里的标准 mcpServers JSON 粘进来。
let MCP_URL = MCP_DEFAULT_URL;
let MCP_KEY = '';

/**
 * 从 dbStorage 读取已保存的 MCP 配置并应用到 MCP_URL/MCP_KEY。
 * 在 startBridge 之前调用，确保使用最新配置。
 */
function loadMcpConfig() {
    try {
        const saved = storeGet('mcp-config');
        if (saved && typeof saved === 'object') {
            if (saved.url) MCP_URL = String(saved.url);
            if (saved.key) MCP_KEY = String(saved.key);
        }
    } catch (e) { /* dbStorage 不可用时静默用默认值 */ }
}

// 模块加载时立即读取一次已保存配置。这样插件每次打开，MCP_URL/MCP_KEY
// 在暴露给页面之前就是最新值，避免 init 渲染早于 startBridge 导致卡片误显示「未配置」。
try { loadMcpConfig(); } catch (e) {}
// 同时恢复访问密钥到内存(window.__bridgeKey)，避免桥接服务已启动但页面 init
// 还没调 setKey 时，服务端 expectedKey 为空导致鉴权状态不一致。
// 安全默认：若用户从未设置过 bridge-key，则首次启动生成随机 key 并持久化，
// 做到「开箱即鉴权」。用户若确实想关鉴权（自用 WiFi 图方便），可在界面显式清空，
// UI 会给出警告——避免「默认裸奔让局域网任意网页可读写剪贴板」的危险状态。
try {
    const existing = storeGet('bridge-key');
    if (existing === null || existing === undefined) {
        const k = generateKey();
        storeSet('bridge-key', k);
        window.__bridgeKey = k;
    } else {
        window.__bridgeKey = existing;
    }
} catch (e) {
    // dbStorage 不可用时退回空 key（极端兜底，不应发生在正常 uTools 环境）
    window.__bridgeKey = '';
}

// PWA 静态文件目录（手机端界面）。插件目录下的 pwa/ 子目录。
// 合并设计：HTTP 服务既服务 /api/* 数据接口，也服务 PWA 界面文件，
// 手机只需访问一个地址（同源），不再需要单独起静态服务。
const PWA_DIR = path.join(__dirname, 'pwa');
// 静态文件 / 字节流路由共用的 MIME 类型映射
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/x-rar-compressed',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// 桥接 HTTP 服务端口。默认 3721，被占用则自动 +1 试到 3730。
const PORT_START = 3721;
const PORT_END = 3730;

// 请求超时。uTools 工具大多是本地操作，30 秒足够；个别（如 markdown 渲染图）可能稍慢。
const MCP_TIMEOUT_MS = 30000;

// ─── MCP 客户端 ─────────────────────────────────────────────────────
// Streamable HTTP over SSE：每个请求带 mcp-session-id 头，响应是
//   event: message
//   data: {"jsonrpc":"2.0","id":N,"result":{...}}
// session 在 initialize 响应头里返回，失效（uTools 重启/重连）时需重新握手。

let mcpSession = null;      // 缓存的 session id
let mcpReqId = 100;         // 自增请求 id（避开 1/2/3 这些 initialize 用过的小数字，便于调试辨识）
let initPromise = null;     // 进行中的握手 Promise，防止并发重复初始化

/**
 * 解析 MCP 的 SSE 响应体，提取 data: 后的 JSON。
 * 响应形如：
 *   event: message
 *   id: xxx
 *   data: {"jsonrpc":"2.0",...}
 * 按规范，同一个 event 的多行 data: 要用换行拼接后再解析（某些传输会把大 JSON 拆成多段）。
 * 这里收集「连续的 data: 行」join 后 parse；空则返回 null。
 * notifications 这类无 id 的请求返回 202 + 空体，正常。
 */
/**
 * 解析 MCP 的 SSE 响应体，提取目标 JSON-RPC 消息。
 * Streamable HTTP 规范允许一次 POST 响应返回多个 SSE 事件(如 progress 通知 + 最终结果)。
 * 按空行切分事件块,逐块解析,优先返回带 id 且与请求 id 匹配的消息;
 * 无匹配 id 时回退到第一个可解析的事件(兼容单事件响应)。
 */
function parseSseBody(body, expectedId) {
    const events = body.split(/\r?\n\r?\n/); // 空行分隔事件块
    let fallback = null;
    for (const evt of events) {
        // 一个事件块内的 data: 行拼接成完整 data
        const dataLines = evt.split(/\r?\n/).filter((l) => l.startsWith('data:'));
        if (!dataLines.length) continue;
        const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n').trim();
        if (!jsonStr) continue;
        try {
            const msg = JSON.parse(jsonStr);
            if (expectedId != null && msg.id === expectedId) return msg; // 精确匹配
            if (!fallback) fallback = msg; // 第一个可解析的作为兜底
        } catch (e) { /* 跳过非 JSON 事件(如 progress 通知) */ }
    }
    return fallback;
}

/**
 * 向 MCP 网关发一个 JSON-RPC 请求，返回 {statusCode, headers, body}。
 * notifications（无 id）返回 202 + 空体；有 id 的请求返回 200 + SSE 体。
 */
function mcpRequest(payload, { withSession = true } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(MCP_URL);
        const bodyStr = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'x-mcp-key': MCP_KEY,
            'Content-Length': Buffer.byteLength(bodyStr),
        };
        if (withSession && mcpSession) {
            headers['mcp-session-id'] = mcpSession;
        }

        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                // 保留 query：部分 MCP 部署用 url 上的查询参数做路由/token，
                // 只用 pathname 会丢掉 search 导致打到错误端点。
                path: url.pathname + url.search,
                method: 'POST',
                headers,
                timeout: MCP_TIMEOUT_MS,
            },
            (res) => {
                let chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            }
        );
        req.on('timeout', () => {
            req.destroy(new Error('MCP 请求超时'));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * 完成 MCP 握手：initialize → 取响应头 mcp-session-id → notifications/initialized。
 * 用 initPromise 保证并发调用只握手一次。
 */
async function ensureSession() {
    if (mcpSession) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        // 1. initialize
        const initRes = await mcpRequest(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'utools-bridge-plugin', version: '1.0.0' },
                },
            },
            { withSession: false }
        );

        if (initRes.statusCode !== 200) {
            mcpSession = null;
            throw new Error(
                `MCP initialize 失败 (HTTP ${initRes.statusCode})。` +
                `请确认 uTools 已开启本地 MCP 服务。body: ${initRes.body.slice(0, 200)}`
            );
        }

        const sid = initRes.headers['mcp-session-id'];
        if (!sid) throw new Error('MCP initialize 响应缺少 mcp-session-id 头');
        mcpSession = sid;

        // 2. notifications/initialized（规范要求，虽然部分实现不强制）
        await mcpRequest(
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { withSession: true }
        );
    })();

    try {
        await initPromise;
    } finally {
        initPromise = null; // 握手结束（无论成败）清掉，下次失败可重试
    }
}

/**
 * 调用一个 MCP 工具。失败时自动清 session 重试一次（应对 uTools 重启后 session 失效）。
 * 返回结构化数据：优先 result.structuredContent，其次 JSON.parse(content[0].text)。
 */
async function callTool(name, args = {}) {
    await ensureSession();

    const doCall = async () => {
        const id = ++mcpReqId;
        const res = await mcpRequest(
            {
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name, arguments: args },
            },
            { withSession: true }
        );

        if (res.statusCode === 404 || res.statusCode === 400) {
            // session 失效的典型表现，抛出让上层重连
            const err = new Error(`MCP session 可能已失效 (HTTP ${res.statusCode})`);
            err.sessionLost = true;
            throw err;
        }
        if (res.statusCode !== 200) {
            throw new Error(`MCP callTool HTTP ${res.statusCode}: ${res.body.slice(0, 300)}`);
        }

        const msg = parseSseBody(res.body, id);
        if (!msg) throw new Error('MCP 响应体无 data 行');
        if (msg.error) throw new Error(`MCP 错误: ${JSON.stringify(msg.error)}`);

        const result = msg.result;
        if (!result) throw new Error('MCP 响应无 result');

        // 优先用结构化输出；没有则解析 text 字段（uTools 部分工具只给 text）
        if (result.structuredContent) return result.structuredContent;
        if (result.content && result.content[0]?.text) {
            try {
                return JSON.parse(result.content[0].text);
            } catch {
                return result.content[0].text; // 纯文本结果原样返回
            }
        }
        return result;
    };

    try {
        return await doCall();
    } catch (e) {
        if (e.sessionLost) {
            // 清掉 session 重新握手后重试一次
            mcpSession = null;
            await ensureSession();
            return await doCall();
        }
        throw e;
    }
}

// ─── REST 路由表 ────────────────────────────────────────────────────
// 每条：{ method, pattern, tool, buildArgs(req) }
// pattern 用正则匹配 pathname，支持 :id 捕获组。
// buildArgs 把 REST 请求(query/body)翻译成对应 MCP tool 的 arguments。

const ROUTES = [
    // ── 待办 ──
    {
        method: 'GET', pattern: /^\/api\/todo\/groups$/,
        tool: 'utools.todo.todo_group_list',
        buildArgs: () => ({}),
    },
    {
        method: 'GET', pattern: /^\/api\/todos$/,
        tool: 'utools.todo.todo_search',
        buildArgs: (q) => {
            const a = {};
            if (q.query) a.query = q.query;
            if (q.group) a.group = q.group;
            if (q.status) a.status = q.status;
            if (q.dueAt) a.dueAt = q.dueAt;
            return a;
        },
    },
    {
        method: 'POST', pattern: /^\/api\/todos$/,
        tool: 'utools.todo.todo_create',
        buildArgs: (_q, body) => {
            if (!body?.content) throw new ApiError(400, 'content 必填');
            const a = { content: body.content };
            if (body.group) a.group = body.group;
            if (body.dueAt) a.dueAt = body.dueAt;
            return a;
        },
    },
    {
        // id 形如 "todo-tasks/1784162228284" 含斜杠，必须用 .+ 捕获整段
        method: 'PATCH', pattern: /^\/api\/todos\/(.+)$/,
        tool: 'utools.todo.todo_update',
        buildArgs: (q, body, match) => {
            const id = decodeURIComponent(match[1]);
            if (!id) throw new ApiError(400, 'id 不能为空');
            if (!body?.patch) throw new ApiError(400, 'patch 必填');
            return { id, patch: body.patch };
        },
    },
    // ── 笔记 ──
    {
        method: 'GET', pattern: /^\/api\/notes$/,
        tool: 'utools.notes.markdown_notes_search',
        buildArgs: (q) => {
            // 前端发 ?q=xxx；MCP 必须收到 query 字段（空串合法，返回最近笔记）
            const a = { query: q.q != null ? q.q : '' };
            const limit = parseInt(q.limit, 10);
            if (q.limit != null && Number.isFinite(limit) && limit > 0) a.limit = limit;
            return a;
        },
    },
    {
        // id 形如 "note/1763253936619" 含斜杠，用 .+ 捕获整段
        method: 'GET', pattern: /^\/api\/notes\/(.+)$/,
        tool: 'utools.notes.markdown_notes_get',
        buildArgs: (q, _b, match) => {
            const id = decodeURIComponent(match[1]);
            if (!id) throw new ApiError(400, 'id 不能为空');
            const a = { id };
            if (q.format) a.format = q.format;
            return a;
        },
    },
    {
        method: 'POST', pattern: /^\/api\/notes$/,
        tool: 'utools.notes.markdown_notes_create',
        buildArgs: (_q, body) => {
            if (!body?.title || !body?.content) throw new ApiError(400, 'title 和 content 必填');
            return { title: body.title, content: body.content };
        },
    },
    // ── 剪贴板 ──
    {
        method: 'GET', pattern: /^\/api\/clipboard$/,
        tool: 'utools.clipboard.clipboard_history_search',
        buildArgs: (q) => {
            const a = {};
            if (q.query) a.query = q.query;
            if (q.type) a.type = q.type;
            const limit = parseInt(q.limit, 10);
            if (q.limit != null && Number.isFinite(limit) && limit > 0) a.limit = limit;
            return a;
        },
    },
    {
        method: 'GET', pattern: /^\/api\/clipboard\/([^/]+)$/,
        tool: 'utools.clipboard.clipboard_history_get',
        buildArgs: (_q, _b, match) => ({ id: decodeURIComponent(match[1]) }),
    },
    {
        method: 'POST', pattern: /^\/api\/clipboard\/copy$/,
        tool: 'utools.clipboard.clipboard_copy',
        buildArgs: (_q, body) => {
            if (!body?.type) throw new ApiError(400, 'type 必填 (text/image/files)');
            // 显式构造，避免多余字段触发 MCP additionalProperties 校验失败
            const a = { type: body.type };
            if (body.type === 'text' && body.text != null) a.text = String(body.text);
            else if (body.type === 'image' && body.image != null) a.image = String(body.image);
            else if (body.type === 'files' && Array.isArray(body.files)) a.files = body.files;
            return a;
        },
    },
];

// ─── HTTP 服务 ──────────────────────────────────────────────────────

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * 常量时间字符串比较，用于鉴权 key 校验，避免时序侧信道。
 * 长度不同也先哈希再比，不泄露长度信息。
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * 生成 16 字节随机 hex key（32 字符），用于首次启动的默认访问密钥。
 * 这样开箱即有鉴权，而不是默认裸奔让局域网任意网页可读写剪贴板。
 */
function generateKey() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * 计算 CORS 响应头。安全策略:
 *   - 不再用 Access-Control-Allow-Origin: *。否则绑 0.0.0.0 + 鉴权失效时,
 *     局域网内任意网页都能 fetch 读写本机剪贴板(含密码)/笔记/待办,还能 POST 投毒剪贴板。
 *   - 改为回显请求方 Origin(仅当客户端发了 Origin 头),配合 Vary: Origin。
 *     同源访问(PWA 与 API 同地址)没有 Origin 头,完全不受影响。
 *   - 关闭鉴权(无 key)时不回显 Origin:消灭「PC 上浏览恶意网页跨域打本机」
 *     这条最现实的路径(同局域网攻击仍在,但那需要 key 本来就泄露)。
 * 返回一个 headers 对象。
 */
function corsHeaders(req, extra = {}) {
    const h = { ...extra };
    h['Access-Control-Allow-Headers'] = 'Content-Type, x-bridge-key';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, OPTIONS';
    const origin = req.headers.origin;
    const hasKey = !!(window.__bridgeKey || '');
    // 只在「有鉴权 key」时回显 Origin:PWA 跨机访问靠 ?key= 传 key + 同源 API 调用,
    // 跨域 fetch 本就必须带 key 才有意义;关闭鉴权时若再回显 Origin,等于把本机
    // 数据库向 PC 上任意网页敞开,风险极高。
    if (origin && hasKey) {
        h['Access-Control-Allow-Origin'] = origin;
        h['Vary'] = 'Origin';
        h['Access-Control-Allow-Credentials'] = 'true';
    }
    return h;
}

function sendJson(res, status, obj, req) {
    const body = JSON.stringify(obj);
    res.writeHead(
        status,
        corsHeaders(req, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        })
    );
    res.end(body);
}

// 请求体最大长度。MCP 工具入参都很小，1MB 足够；超限直接中断，防恶意流撑爆内存。
const MAX_BODY_BYTES = 1 * 1024 * 1024;
// 上传文件（multipart）大小上限。手机端传图片/小文件用，20MB 足够大多数场景；
// 再大就该走专门的文件同步而非剪贴板通道。超限在累积阶段就断开连接。
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// 上传扩展名黑名单：可执行 / 脚本 / 系统敏感文件。剪贴板历史是「复制即点开」语义，
// 收这些类型等于把可执行代码投递到 PC，列入黑名单降低「误点 / 误粘到别处」风险。
const UPLOAD_BLOCKED_EXT = /^\.(exe|bat|cmd|ps1|sh|js|mjs|vbs|wsf|msi|scr|com|jar|dll|sys|reg)$/i;

function readBody(req) {
    return new Promise((resolve) => {
        let chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c) => {
            if (tooLarge) return;
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                req.destroy(); // 立刻断开，不再累积
                return resolve({ __bodyError: new ApiError(413, '请求体过大 (>1MB)') });
            }
            chunks.push(c);
        });
        req.on('error', () => resolve({ __bodyError: new ApiError(400, '请求数据读取失败') }));
        req.on('end', () => {
            if (tooLarge) return; // 已在 data 里 resolve
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve({}); // 非 JSON 体当空对象
            }
        });
    });
}

// ─── multipart/form-data 解析（手写，不引入依赖）──────────────────────
// 仅服务于 POST /api/clipboard/upload（手机上传图片/小文件）。设计极简：
//   - 只接受单一文件 part（字段名固定为 `file`）+ 可选的 `type` 文本字段
//   - 流式累积到 maxBytes 上限，超限即断；不缓冲多份
//   - 返回 { file: { filename, mimeType, data:Buffer }, type?: string }
// 非multipart 或无文件 part → 抛 ApiError(400)。超限 → 抛 ApiError(413)。
function readMultipart(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const ct = req.headers['content-type'] || '';
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
        if (!m) return reject(new ApiError(400, '请求不是 multipart/form-data'));
        // boundary 在 body 里前面加 "--"，结尾加 "--"
        const boundary = Buffer.from('--' + (m[1] || m[2]));

        const parts = [];
        let buf = Buffer.alloc(0);
        let tooLarge = false;
        let ended = false;
        const finish = () => { if (!ended) { ended = true; resolve(parts); } };
        const fail = (e) => { if (!ended) { ended = true; req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onErr); reject(e); } };

        const onData = (chunk) => {
            if (tooLarge || ended) return;
            buf = Buffer.concat([buf, chunk]);
            // 粗略上限：累计 buffer 超过 maxBytes+4KB(头部余量) 即判超限
            if (buf.length > maxBytes + 4096) {
                tooLarge = true;
                try { req.destroy(); } catch (e) {}
                fail(new ApiError(413, '上传文件过大 (>20MB)'));
                return;
            }
            // 尝试切出完整的 part（以 boundary 分隔）
            // 留 1KB 尾巴防止把跨 chunk 的 boundary 切断
            while (true) {
                const idx = buf.indexOf(boundary);
                if (idx < 0) break;
                const part = buf.slice(0, idx);
                buf = buf.slice(idx + boundary.length);
                parts.push(part);
                // parts[0] 通常是 preamble（空或换行），忽略；保留并在解析阶段过滤
            }
        };
        const onEnd = () => { if (tooLarge || ended) return; finish(); };
        const onErr = () => fail(new ApiError(400, '上传数据读取失败'));

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onErr);
    }).then((parts) => {
        // 解析每个 part：跳过 preamble/空 part，找 Content-Disposition: ...; name="file"; filename="..."
        let filePart = null;
        let typeVal = null;
        for (const raw of parts) {
            if (!raw || raw.length === 0) continue;
            // part = 头部\r\n\r\n体。头部和体之间是 \r\n\r\n
            const sep = raw.indexOf('\r\n\r\n');
            const sepLen = 4;
            const headEnd = sep >= 0 ? sep : raw.indexOf('\n\n');
            const s = sep >= 0 ? sepLen : 2;
            if (headEnd < 0) continue; // 没头部分隔，跳过
            const head = raw.slice(0, headEnd).toString('utf8');
            const body = raw.slice(headEnd + s);
            // 去掉 body 尾部 \r\n（boundary 前的换行）
            let bodyTrim = body;
            if (bodyTrim.length >= 2 && bodyTrim[bodyTrim.length - 2] === 0x0d && bodyTrim[bodyTrim.length - 1] === 0x0a) {
                bodyTrim = bodyTrim.slice(0, bodyTrim.length - 2);
            }
            const nameM = /name="([^"]*)"/.exec(head);
            const fnameM = /filename="([^"]*)"/.exec(head);
            const name = nameM ? nameM[1] : '';
            if (fnameM && name === 'file') {
                if (filePart) throw new ApiError(400, '一次只能上传一个文件');
                const ctm = /Content-Type:\s*([^\r\n]+)/i.exec(head);
                filePart = {
                    filename: fnameM[1],
                    mimeType: ctm ? ctm[1].trim() : 'application/octet-stream',
                    data: bodyTrim,
                };
            } else if (name === 'type' && !fnameM) {
                typeVal = bodyTrim.toString('utf8').trim();
            }
        }
        if (!filePart) throw new ApiError(400, '未找到上传的文件');
        return { file: filePart, type: typeVal };
    });
}

let server = null;
let currentPort = null;
let recentLogs = []; // 最近 50 条请求日志，供控制台 UI 展示

function logRequest(method, path, status, note = '') {
    const entry = {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        method, path, status, note,
    };
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
    // 通知前端 UI 刷新（前端监听这个事件）
    if (typeof window !== 'undefined' && window.__bridgeOnLog) {
        window.__bridgeOnLog(entry);
    }
}

async function handleRequest(req, res) {
    // 最外层兜底：任何 throw（如 decodeURIComponent 遇到非法 % 编码抛 URIError）
    // 都不能逃逸成 unhandledRejection —— Node ≥15 默认会因此退出进程，
    // 局域网任意设备一个畸形请求就能打挂整插件。这里统一吞掉返回 400。
    try {
        return await dispatchRequest(req, res);
    } catch (e) {
        if (!res.headersSent) {
            // 客户端错误:ApiError 自带 status;URIError(非法 URL 编码)也算 400;
            // 其他意外(如文件 IO、内部断言)按服务器内部错误 500,不误导成客户端问题。
            const isClientErr = e?.status || e instanceof URIError;
            const code = e?.status || (isClientErr ? 400 : 500);
            try {
                sendJson(res, code, { ok: false, error: e?.message || '请求处理异常' }, req);
            } catch {
                try { res.writeHead(code); res.end(); } catch {}
            }
        }
    }
}

/**
 * 剪贴板字节路由分发器。处理三条不走 MCP 的特殊路由：
 *   GET  /api/clipboard/:id/blob   —— image 项的字节流（缩略图/大图 <img> 用）
 *   GET  /api/clipboard/file       —— files 项里指定文件的下载字节
 *   POST /api/clipboard/upload     —— 手机上传图片/小文件到 PC 剪贴板
 * 匹配则完成响应并返回 true，调用方应直接 return；不匹配返回 false。
 *
 * 设计：这些路由不能放进 ROUTES 表，因为 ROUTES 统一走 callTool → JSON；
 * 这里要直接文件 IO 并流式输出字节。但鉴权复用上层（进入此函数前已校验过 key）。
 */
async function handleClipboardByteRoute(req, res, method, pathname, url) {
    // ── A. 图片字节流 ──
    let m;
    if (method === 'GET' && (m = /^\/api\/clipboard\/([^/]+)\/blob$/.exec(pathname))) {
        const id = decodeURIComponent(m[1]);
        try {
            const item = await callTool('utools.clipboard.clipboard_history_get', { id });
            if (!item || item.type !== 'image' || !item.image) {
                return sendJson(res, 400, { ok: false, error: '该剪贴板项不是图片' }, req), true;
            }
            const imgPath = item.image;
            // 安全闸：image 路径必须落在 uTools clipboard-data 目录内，防伪造路径越权读任意文件。
            // 宽容处理：若 clipboard-data 目录推断不到（非 Win），退化为「至少在 homedir 内」。
            const root = getClipboardDataRoot();
            const baseOk = isPathInside(imgPath, root) || isPathInside(imgPath, os.homedir());
            if (!baseOk) {
                logRequest('GET', pathname, 403, 'image 路径越权');
                return sendJson(res, 403, { ok: false, error: '图片路径不在允许范围内' }, req), true;
            }
            logRequest('GET', pathname, 200, 'blob:image');
            return sendFileStream(res, req, imgPath, { 'Content-Disposition': 'inline' });
        } catch (e) {
            logRequest('GET', pathname, 500, e.message.slice(0, 80));
            return sendJson(res, 500, { ok: false, error: e.message }, req), true;
        }
    }

    // ── C. 文件下载（必须在 query 里带 id 和 path）──
    if (method === 'GET' && pathname === '/api/clipboard/file') {
        const id = url.searchParams.get('id');
        const wantPath = url.searchParams.get('path');
        if (!id || !wantPath) {
            return sendJson(res, 400, { ok: false, error: '缺少 id 或 path 参数' }, req), true;
        }
        try {
            const item = await callTool('utools.clipboard.clipboard_history_get', { id: decodeURIComponent(id) });
            const files = Array.isArray(item?.files) ? item.files : [];
            // 安全闸：请求的 path 必须**精确匹配**该剪贴板项 files 数组里的某条。
            // 不能做前缀/模糊匹配——否则可以构造 path 指向任意 PC 文件。
            const target = files.find((f) => f && f.path && path.resolve(f.path) === path.resolve(decodeURIComponent(wantPath)));
            if (!target) {
                logRequest('GET', pathname, 403, '文件路径不属于该剪贴板项');
                return sendJson(res, 403, { ok: false, error: '该文件不属于此剪贴板项' }, req), true;
            }
            // 安全闸：与 blob 路由一致，下载路径必须落在 uTools clipboard-data 目录内（兜底 homedir）。
            // 仅靠 id↔path 绑定不够——copy 路由会把任意 path 透传进 files 数组，攻击者可借此越权读 PC 文件。
            const fileRoot = getClipboardDataRoot();
            if (!isPathInside(target.path, fileRoot) && !isPathInside(target.path, os.homedir())) {
                logRequest('GET', pathname, 403, 'file 路径越权');
                return sendJson(res, 403, { ok: false, error: '文件路径不在允许范围内' }, req), true;
            }
            if (target.type === 'folder' || (target.isDirectory != null && target.isDirectory)) {
                return sendJson(res, 400, { ok: false, error: '暂不支持下载文件夹（仅支持单个文件）' }, req), true;
            }
            if (target.exist === false) {
                return sendJson(res, 404, { ok: false, error: '源文件已不存在（可能在 PC 上被移动或删除）' }, req), true;
            }
            // 文件名 sanitize：只保留 basename，去掉任何目录部分（防 filename 里塞 ../）
            const safeName = path.basename(target.path) || 'download';
            // Content-Disposition 必须用 ASCII：非 ASCII 文件名（中文等）裸塞进 filename=""
            // 会被 Node http 拒收（"Invalid character in header"）报 500。
            // 解法（RFC 5987）：filename= 给个 ASCII 兜底（非 ASCII 换成 _），
            // filename*=UTF-8''<percent-encoded> 给浏览器真实 UTF-8 名字。
            const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_') || 'download';
            const utf8Name = encodeURIComponent(safeName);
            const disposition = asciiName === utf8Name
                ? "attachment; filename=\"" + asciiName + "\""
                : "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + utf8Name;
            logRequest('GET', pathname, 200, 'file:' + asciiName);
            return sendFileStream(res, req, target.path, {
                'Content-Disposition': disposition,
                // 下载用无缓存，避免同一 path 指向不同文件时拿到旧缓存
                'Cache-Control': 'no-store',
            });
        } catch (e) {
            logRequest('GET', pathname, 500, e.message.slice(0, 80));
            return sendJson(res, 500, { ok: false, error: e.message }, req), true;
        }
    }

    // ── B. 上传（multipart）──
    if (method === 'POST' && pathname === '/api/clipboard/upload') {
        const ct = req.headers['content-type'] || '';
        if (!/multipart\/form-data/i.test(ct)) {
            return sendJson(res, 400, { ok: false, error: '上传必须用 multipart/form-data' }, req), true;
        }
        let parsed;
        try {
            parsed = await readMultipart(req, MAX_UPLOAD_BYTES);
        } catch (e) {
            const code = e.status || 400;
            logRequest('POST', pathname, code, e.message.slice(0, 80));
            return sendJson(res, code, { ok: false, error: e.message }, req), true;
        }
        const { file, type: typeHint } = parsed;

        // 文件名清洗：只取 basename；空名兜底；扩展名黑名单拦截可执行/脚本
        let safeName = path.basename(file.filename || '');
        if (!safeName) safeName = 'upload-' + Date.now();
        const ext = path.extname(safeName).toLowerCase();
        if (UPLOAD_BLOCKED_EXT.test(ext)) {
            return sendJson(res, 400, { ok: false, error: '不支持上传该类型文件（可执行/脚本被拒绝）' }, req), true;
        }
        if (file.data.length === 0) {
            return sendJson(res, 400, { ok: false, error: '文件内容为空' }, req), true;
        }

        // 临时目录：os.tmpdir() 下建专属子目录，避免和其它进程争用
        const tmpDir = path.join(os.tmpdir(), 'utools-bridge-uploads');
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
        // 加时间戳+随机后缀防重名覆盖
        const unique = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        const tmpPath = path.join(tmpDir, unique + '-' + safeName);
        try {
            fs.writeFileSync(tmpPath, file.data);
        } catch (e) {
            return sendJson(res, 500, { ok: false, error: '临时文件写入失败: ' + e.message }, req), true;
        }

        // 推断 type：显式 type 优先，否则图片 MIME/扩展名 → image，其它一律 files
        let copyType = typeHint;
        if (!copyType) {
            copyType = /^image\//i.test(file.mimeType) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(safeName)
                ? 'image' : 'files';
        }
        if (copyType !== 'image' && copyType !== 'files') {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            return sendJson(res, 400, { ok: false, error: 'type 必须是 image 或 files' }, req), true;
        }

        try {
            const args = { type: copyType };
            if (copyType === 'image') args.image = tmpPath;
            else args.files = [tmpPath];
            const data = await callTool('utools.clipboard.clipboard_copy', args);
            logRequest('POST', pathname, 200, 'upload:' + copyType);
            return sendJson(res, 200, { ok: true, data }, req), true;
        } catch (e) {
            logRequest('POST', pathname, 500, e.message.slice(0, 80));
            return sendJson(res, 500, { ok: false, error: '上传已落盘但写入剪贴板失败: ' + e.message }, req), true;
        } finally {
            // 用后即删：uTools 已经把文件拷进自己的 clipboard-data 目录，临时文件只是中转
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
    }

    return false; // 不匹配，交给后续 ROUTES
}

async function dispatchRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    const method = req.method;

    // CORS 预检：回显 Origin（不再用 *，见 corsHeaders 说明）
    if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        return res.end();
    }

    // 健康检查（手机端用来探测连通性 + 拿服务信息）—— 免鉴权
    if (pathname === '/api/health') {
        return sendJson(res, 200, {
            ok: true,
            data: { service: 'utools-bridge', port: currentPort, time: Date.now() },
        }, req);
    }

    // ── 静态文件服务（PWA 界面）──
    // /api/* 走数据路由，其余都当 PWA 静态文件处理。
    // 手机访问 http://PC_IP:PORT/ 直接拿到 PWA 界面，与 /api 同源，无需填地址。
    // 静态文件免鉴权：浏览器自动发起的子资源请求(manifest/icon/sw)无法携带 key,
    // 且界面 HTML 本身无数据——所有数据都在 /api/* 走鉴权。PWA 加载后用 localStorage
    // 里的 key 通过 x-bridge-key 头调 /api,刷新/重开/添加到主屏幕都不受影响。
    if (!pathname.startsWith('/api/')) {
        return serveStatic(req, res, pathname);
    }

    // ── /api/* 鉴权 ──
    // 仅数据接口需要 key。两种方式：
    //   1) x-bridge-key 请求头 —— PWA 的 fetch 调用用这个(从 localStorage 取 key)；
    //   2) ?key= 查询参数 —— 偶尔浏览器直接打开 /api/xxx?key= 时兜底。
    // 常量时间比较避免时序侧信道。
    const expectedKey = window.__bridgeKey || '';
    if (expectedKey) {
        const headerKey = req.headers['x-bridge-key'] || '';
        const queryKey = url.searchParams.get('key') || '';
        if (!safeEqual(headerKey, expectedKey) && !safeEqual(queryKey, expectedKey)) {
            logRequest(method, pathname, 401, 'key 不匹配');
            return sendJson(res, 401, { ok: false, error: 'x-bridge-key 不匹配' }, req);
        }
    }

    // ── 剪贴板字节路由（不走 MCP，直接文件 IO）──
    // MCP 的 clipboard_history_get 只返回 PC 本地路径，没有字节；要让手机看到图片/下载文件，
    // 必须在桥接层新增字节传输路由。三条路由都用同一套鉴权（已在上文校验过）。
    // 安全双闸：(A) image 路径必须在 uTools clipboard-data 目录内；(C) 文件下载 path 必须
    // 精确属于对应 id 的 files 数组 —— 任一不满足直接 400/404。
    if (await handleClipboardByteRoute(req, res, method, pathname, url)) return;

    // 路由匹配
    const route = ROUTES.find((r) => r.method === method && r.pattern.test(pathname));
    if (!route) {
        logRequest(method, pathname, 404, '无匹配路由');
        return sendJson(res, 404, { ok: false, error: `无匹配路由: ${method} ${pathname}` }, req);
    }

    try {
        const match = pathname.match(route.pattern);
        const query = Object.fromEntries(url.searchParams);
        let body = {};
        if (method === 'POST' || method === 'PATCH') {
            body = await readBody(req);
            if (body?.__bodyError) throw body.__bodyError;
        }
        const args = route.buildArgs(query, body, match);

        const data = await callTool(route.tool, args);
        logRequest(method, pathname, 200, route.tool);
        sendJson(res, 200, { ok: true, data }, req);
    } catch (e) {
        const status = e.status || 500;
        logRequest(method, pathname, status, e.message.slice(0, 80));
        sendJson(res, status, { ok: false, error: e.message }, req);
    }
}

/**
 * 服务 PWA 静态文件。根路径 / 映射到 index.html。
 * 路径安全：用 path.normalize + 限制在 PWA_DIR 内，防止 ../ 越权读到插件其他文件。
 */
function serveStatic(req, res, pathname) {
    // 静态文件只允许 GET/HEAD,拒绝 POST/PUT/DELETE 等(避免用文件路由做副作用)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end('Method Not Allowed');
    }
    // 归一化路径，把根路径和目录访问都导向 index.html
    let relPath = decodeURIComponent(pathname);
    if (relPath === '/' || relPath === '') relPath = '/index.html';

    // 防路径穿越：解析后必须在 PWA_DIR 内
    const filePath = path.join(PWA_DIR, relPath);
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith(PWA_DIR + path.sep) && normalized !== PWA_DIR) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    // 不存在的文件：对非资源路径回退到 index.html（PWA 前端路由友好），
    // 避免手机刷新某个深层路径时白屏。带点的（如 .js/.css）是真资源，404 即可。
    if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
        if (path.extname(relPath) === '') {
            const fallback = path.join(PWA_DIR, 'index.html');
            if (fs.existsSync(fallback)) {
                return sendFile(res, fallback);
            }
        }
        logRequest('GET', pathname, 404, '静态文件未找到');
        res.writeHead(404);
        return res.end('Not Found');
    }

    return sendFile(res, normalized);
}

function sendFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    } catch (e) {
        res.writeHead(500);
        res.end('读取文件失败');
    }
}

/**
 * 流式发送文件字节（剪贴板图片/文件下载用）。
 * 用 fs.createReadStream + pipe，避免大图片一次性读进内存。
 * 返回 true 表示已响应（成功或失败都已 end），调用方不要再 write。
 */
function sendFileStream(res, req, filePath, extraHeaders = {}) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        logRequest(req.method, req.url.split('?')[0], 404, '文件不存在: ' + path.basename(filePath));
        return sendJson(res, 404, { ok: false, error: '文件不存在' }, req), true;
    }
    if (stat.isDirectory()) {
        return sendJson(res, 400, { ok: false, error: '目标是文件夹，不支持直接下载' }, req), true;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const headers = Object.assign(
        {
            'Content-Type': mime,
            'Content-Length': stat.size,
            // 私有缓存：图片缩略图短时间内可复用（同 id 内容不变），但不进共享缓存
            'Cache-Control': 'private, max-age=60',
        },
        extraHeaders
    );
    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
        // 流读到一半出错，头部已发，只能强行结束
        try { res.end(); } catch (e) {}
    });
    stream.pipe(res);
    return true;
}

/**
 * 计算 uTools 剪贴板图片/文件的数据根目录（路径白名单基准）。
 * uTools 把图片保存在 %APPDATA%\uTools\clipboard-data\<timestamp>\<id>。
 * Windows 用 %APPDATA%（Roaming），其它平台兜底用 homedir 下隐藏目录。
 * 返回归一化后的绝对路径（小写比较在 Windows 不区分大小写，这里返回原样，
 * 判定时用 path.relative 处理）。
 */
function getClipboardDataRoot() {
    const home = os.homedir();
    // Windows: C:\Users\<u>\AppData\Roaming\uTools\clipboard-data
    const winAppData = process.env.APPDATA;
    if (process.platform === 'win32' && winAppData) {
        return path.join(winAppData, 'uTools', 'clipboard-data');
    }
    // macOS / Linux 兜底（uTools 主力在 Win，这里给个合理猜测）
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'uTools', 'clipboard-data');
    }
    return path.join(home, '.config', 'uTools', 'clipboard-data');
}

/**
 * 判断 targetPath 是否安全地位于 baseDir 内（防 ../ 越权）。
 * 用 path.relative：若结果以 '..' 开头或为绝对路径，则 target 在 base 之外。
 */
function isPathInside(targetPath, baseDir) {
    if (!targetPath || !baseDir) return false;
    let t, b;
    try {
        t = path.resolve(targetPath);
        b = path.resolve(baseDir);
    } catch (e) {
        return false;
    }
    const rel = path.relative(b, t);
    if (!rel || rel === '') return true; // 完全相等
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// 跟踪当前活跃连接，stopBridge 时强制销毁，避免 keep-alive 连接拖住关闭。
let activeSockets = new Set();

function startServer(port) {
    return new Promise((resolve, reject) => {
        const s = http.createServer(handleRequest);
        // 防止 slowloris：请求头/整体请求超时，超时即中断连接。
        s.requestTimeout = 20000;  // 20s 内必须把请求发完
        s.headersTimeout = 15000;  // 15s 内必须发完请求头
        s.on('connection', (socket) => {
            activeSockets.add(socket);
            socket.on('close', () => activeSockets.delete(socket));
        });
        s.on('error', (e) => reject(e));
        s.listen(port, '0.0.0.0', () => {
            resolve(s);
        });
    });
}

/**
 * 依次尝试 PORT_START..PORT_END，找到第一个可用端口启动。
 * 返回实际监听端口。
 */
// 进行中的启动 Promise，串行化防止并发启动创建多个泄漏的 server。
// 场景：UI 快速双击启动按钮、setMcpConfig 自动重启与手动启动竞争。
// 模式与 initPromise 一致：进行中时复用同一 Promise，结束（成败）后清空。
let startingPromise = null;

// stopBridge 发起标记:doStartBridge 完成后若发现已 stop,立即关闭新 server 不赋值,防泄漏。
let stopping = false;

async function doStartBridge() {
    // 每次启动前重新加载已保存的 MCP 配置（用户可能在前端改过 key）
    loadMcpConfig();

    // key 没配：直接给清晰引导，不用去打 MCP（必 403）
    if (!MCP_KEY) {
        throw new Error('尚未配置 MCP key。请在下方「MCP 配置」粘贴 uTools 设置里的配置 JSON。');
    }

    // 先探一下 MCP 通不通（快速失败提示）
    try {
        await ensureSession();
    } catch (e) {
        const msg = e.message || '';
        // 403 通常是 key 不匹配（每用户独有密钥），给针对性提示
        const hint = /403|Unauthorized|key/i.test(msg)
            ? 'MCP key 不匹配。请重新从 uTools 设置复制配置 JSON 粘到「MCP 配置」。'
            : '无法连接 uTools MCP 服务（127.0.0.1:3501）。请确认 uTools 已开启本地 MCP。';
        throw new Error(hint + '（' + msg + '）');
    }

    let lastErr;
    for (let p = PORT_START; p <= PORT_END; p++) {
        try {
            const s = await startServer(p);
            // 启动期间若 stopBridge 已发起,立即关闭这个新 server 不赋值,避免泄漏。
            if (stopping) {
                try { s.close(); } catch (e) {}
                for (const sock of activeSockets) { try { sock.destroy(); } catch (e) {} }
                activeSockets.clear();
                stopping = false;
                throw new Error('启动被停止');
            }
            server = s;
            currentPort = p;
            return p;
        } catch (e) {
            if (e.code === 'EADDRINUSE') { lastErr = e; continue; }
            throw e;
        }
    }
    throw new Error(`端口 ${PORT_START}-${PORT_END} 全部被占用: ${lastErr?.message}`);
}

/**
 * 启动桥接。并发安全：进行中的启动复用同一 Promise，
 * 避免两个 start 调用各创建一个 server（旧 server 泄漏且持续监听）。
 * 已在运行则直接返回当前端口。
 */
function startBridge() {
    if (server) return Promise.resolve(currentPort);
    if (startingPromise) return startingPromise;
    stopping = false; // 新启动清掉 stop 标记
    startingPromise = doStartBridge().finally(() => { startingPromise = null; });
    return startingPromise;
}

function stopBridge() {
    // 标记正在停止:进行中的 doStartBridge 完成后会检查此标记并关闭新 server 不赋值。
    stopping = true;
    startingPromise = null;
    return new Promise((resolve) => {
        if (!server) return resolve();
        // 先销毁所有活跃连接，否则 keep-alive 的空闲连接会让 close() 的回调迟迟不触发。
        for (const sock of activeSockets) {
            try { sock.destroy(); } catch (e) {}
        }
        activeSockets.clear();
        server.close(() => {
            server = null;
            currentPort = null;
            mcpSession = null; // 停服务时也清掉 session，下次重连
            resolve();
        });
    });
}

/**
 * 把 key 脱敏成 `前4位...后4位` 形式，用于 UI 展示，避免完整暴露。
 */
function maskKey(k) {
    if (!k) return '';
    if (k.length <= 8) return '****';
    return k.slice(0, 4) + '...' + k.slice(-4);
}

/**
 * 取本机局域网 IPv4 地址（排除回环和虚拟网卡），供 UI 展示给用户。
 *
 * 两层过滤避免选到 VPN/隧道地址：
 *   1. 网卡名黑名单（覆盖常见虚拟/隧道：VMware/Hyper-V/Docker/WSL/Wintun/TAP/各种 VPN）
 *   2. 掩码启发式：点对点隧道(VPN/WireGuard 等)常是 /32(255.255.255.255)，
 *      真实局域网是 /24 或更宽，优先选非 /32 的地址。
 * 候选再排序，避免依赖 os.networkInterfaces() 的枚举顺序——Windows 下虚拟网卡
 * (如 Wintun 隧道)常排在物理网卡前面，会直接选错地址。
 */
function getLanIp() {
    const ifaces = os.networkInterfaces();
    // 虚拟网卡 / 隧道网卡名关键字（不区分大小写）
    const VIRTUAL = /vmware|virtualbox|docker|wsl|vethernet|hyper-?v|loopback|^veth|tap|tunnel|wintun|vgate|vpn|hamachi|zerotier|tailscale|wireguard|openvpn|pptp|l2tp|host-?only|virtual/i;
    const candidates = [];
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            if (VIRTUAL.test(name)) continue;
            // 跳过 APIPA 自动地址 169.254.x.x：网卡没拿到 DHCP 地址时的占位值，
            // 压根没有真实网络连接，绝不能作为"局域网 IP"返回给用户。
            if (/^169\.254\./.test(iface.address)) continue;
            // /32 掩码通常是点对点 VPN 隧道，真实 LAN 一般是 /24 及更宽
            const pointToPoint = iface.netmask === '255.255.255.255';
            candidates.push({ name, address: iface.address, pointToPoint });
        }
    }
    // 优先非点对点的真实局域网地址；同级稳定排序，不依赖枚举顺序
    candidates.sort((a, b) => {
        if (a.pointToPoint !== b.pointToPoint) return a.pointToPoint ? 1 : -1;
        return a.address.localeCompare(b.address);
    });
    return candidates[0]?.address || '未知';
}

// ─── 暴露给前端 ─────────────────────────────────────────────────────
window.bridge = {
    start: async () => {
        const port = await startBridge();
        return { port, lanIp: getLanIp() };
    },
    stop: stopBridge,
    status: () => ({
        running: !!server,
        port: currentPort,
        lanIp: getLanIp(),
        session: mcpSession ? '已连接' : '未连接',
    }),
    getLogs: () => recentLogs.slice(),
    // 前端设置可选鉴权 key（设备隔离持久化，不随云同步扩散）
    setKey: (key) => { window.__bridgeKey = key || ''; storeSet('bridge-key', key || ''); },
    getKey: () => {
        // 优先内存,兜底 store:防止 preload 重载后 __bridgeKey 未恢复时拼出的访问地址不带 key
        if (window.__bridgeKey) return window.__bridgeKey;
        return storeGet('bridge-key') || '';
    },
    // 重新生成随机 key（用户想换 key 时用）。持久化并返回新 key 明文（仅此处返回明文一次）。
    regenerateKey: () => {
        const k = generateKey();
        window.__bridgeKey = k;
        storeSet('bridge-key', k);
        return k;
    },
    // 读系统剪贴板文本。「从剪贴板导入」按钮用——uTools 没有公开读剪贴板 API，
    // 通过 electron.clipboard 实现（文档「引入 Electron 渲染进程 API」）。
    readClipboard: () => {
        if (electronClipboard) return electronClipboard.readText() || '';
        return '';
    },

    // ── MCP 配置（一键粘贴 uTools 标准配置 JSON）──
    /**
     * 写入 MCP 配置。cfg = { url?, key? }，缺省字段保留旧值不覆盖。
     * 若桥接正在运行：自动 stop → 更新变量 → start 重启（同端口或下一个可用端口）。
     * 返回应用后的完整配置 { url, key }（key 已脱敏）。
     */
    setMcpConfig: async (cfg) => {
        if (!cfg || typeof cfg !== 'object') throw new Error('配置格式错误');
        // clear:true = 清空已保存的 key（回到未配置状态）
        if (cfg.clear) {
            const wasRunning = !!server;
            if (wasRunning) await stopBridge();
            storeDel('mcp-config');
            MCP_URL = MCP_DEFAULT_URL;
            MCP_KEY = '';
            mcpSession = null;
            return { url: MCP_URL, key: maskKey(MCP_KEY) };
        }
        let nextUrl = MCP_URL, nextKey = MCP_KEY;
        if (cfg.url != null) {
            if (typeof cfg.url !== 'string' || !/^https?:\/\//i.test(cfg.url)) {
                throw new Error('url 必须是 http(s):// 开头的字符串');
            }
            nextUrl = cfg.url.trim();
        }
        if (cfg.key != null) {
            if (typeof cfg.key !== 'string' || !cfg.key.trim()) {
                throw new Error('key 不能为空');
            }
            nextKey = cfg.key.trim();
        }

        // 持久化（url/key 都存全量，读取时再脱敏）
        const toSave = { url: nextUrl, key: nextKey };
        storeSet('mcp-config', toSave);

        const wasRunning = !!server;
        if (wasRunning) await stopBridge();

        MCP_URL = nextUrl;
        MCP_KEY = nextKey;
        mcpSession = null; // 清掉旧会话，下次请求用新 key 重新握手

        if (wasRunning) {
            try { await startBridge(); }
            catch (e) { throw new Error('配置已保存但重启失败: ' + e.message); }
        }
        return { url: MCP_URL, key: maskKey(MCP_KEY) };
    },
    /**
     * 返回当前 MCP 配置，key 脱敏（避免在 UI 完整暴露）。
     * 每次都先 loadMcpConfig：修复插件重新打开时，init 渲染早于 startBridge，
     * MCP_KEY 仍是模块初始空串、卡片误显示「未配置」的时序 bug。
     */
    getMcpConfig: () => { loadMcpConfig(); return { url: MCP_URL, key: maskKey(MCP_KEY) }; },
};

// ─── 生命周期 ───────────────────────────────────────────────────────
// 插件被结束运行（进程被杀）时，主动停止 HTTP 服务释放端口/连接。
// 文档 onPluginOut(isKill)：isKill=true 表示进程即将退出。
// 仅在 isKill 时停止；隐藏后台(isKill=false)不停，让用户切回时服务仍在。
try {
    utools.onPluginOut((isKill) => {
        if (isKill) {
            try { stopBridge(); } catch (e) {}
        }
    });
} catch (e) { /* 旧版 uTools 可能无此 API，忽略 */ }
