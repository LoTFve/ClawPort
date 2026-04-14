# 🤖 Port Monitor - AI 开发协作规范 (Agents.md)

这份文件约定了当前 `port-monitor` 项目相关的开发规范。作为 AI 辅助编程助手（Agent），在针对本项目进行需求分析、代码修改或架构调整时，**必须严格遵守以下规则**。

---

## 1. 🏗️ 架构与技术栈约束

1. **核心环境**：
   - 后端使用纯 Node.js（Node.js 原生 API 优先，遵循 CommonJS `require` 规范，暂不自动激进转为 ES Modules）。
   - 前端采用 原生 JavaScript (Vanilla JS)、HTML5 和 CSS3。
2. **轻量化原则**：
   - **禁止**擅自引入 React/Vue/Angular 等前端重型框架。
   - **禁止**擅自引入 TailwindCSS 或是其他重型构建工具（如 Webpack/Vite），除非用户显式要求。
3. **三路数据采集架构**：
   - `wssBrowser`（路径 `/`）：负责将整合后的数据推给浏览器前端。
   - `wssAgent`（路径 `/agent`）：负责接收由 `agent.js` 主动上报的远程边缘服务器数据（WebSocket Agent 模式）。
   - **SSH 采集模式**：服务端通过 `ssh2` 库主动连接 `config.yml` 中配置的 `ssh_servers`，定期执行 `ss -ntup -l -H` 命令，解析后写入 `agents` Map（type: `'ssh'`）。
   - 修补通信逻辑时，注意维持三路数据流的独立性，不要在 `wssBrowser` 和 `wssAgent` 之间建立直接耦合。

## 2. 💻 跨平台与命令兼容性

由于 `agent.js` 会被部署在各种未知的远程机器上：
1. **指令分发**：任何涉及系统底层查询动作（如端口信息、进程状态、硬件负载），在编写代码时**必须进行操作系统环境（Windows vs Linux / macOS）的判别**。
    - Windows 下优先使用 `netstat -ano` 和 `tasklist`。
    - Linux / macOS 下优先使用 `ss -ntup` 或降级到 `netstat -tunap`（`exec` 中用 `||` 做 fallback）。
    - `server.js` 的本地采集函数 `getPortInfo()` 同样需要遵守此规则。
2. **容错性**：底层 `exec` 命令或者 WebSocket 会话极易出现网络抖动、进程不存在或权限不足，必须有严谨的 `catch` 或 `on('error')` 处理，确保单个错误不会阻塞掉主线程。

## 3. ⚙️ 配置文件规范

项目通过 **YAML 文件** 管理所有参数，禁止在代码中写硬编码的业务配置值。

1. **`config.yml`（服务端）**：
   ```yaml
   dashboard:
     port: 13457                 # 监听端口
     ssh_polling_interval: 15000 # SSH 轮询间隔 (ms)
     default_refresh_ms: 10000   # 浏览器默认刷新率 (ms)

   ssh_servers:
     - id: "unique-id"
       name: "显示名称"
       host: "hostname-or-ip"
       port: 22
       username: "root"
       privateKeyPath: "C:\\path\\to\\key.pem"
   ```

2. **`agent_config.yml`（远程 Agent）**：
   ```yaml
   master_url: "ws://dashboard-host:13457"
   agent_id: "unique-agent-id"
   agent_name: "显示名称"
   refresh_interval: 10000    # Agent 上报间隔 (ms)
   reconnect_interval: 10000  # 断线重连间隔 (ms)
   ```

3. **加载优先级**：环境变量 > YAML 文件。配置缺失时应给出合理默认值，**禁止** `process.exit(1)` 级别的强制退出（除非是完全无法运行的关键参数，如 `master_url`）。

## 4. 📦 数据结构与状态规范

1. **连接状态归一化**：所有后端（本地采集、SSH 采集、Agent 上报）输出的连接状态，**必须**通过 `normalizeState()` 函数统一映射后再存储或下发：
   - `LISTEN` / `LISTENING` → `LISTENING`
   - `ESTAB` / `ESTABLISHED` → `ESTABLISHED`
   - `TIME-WAIT` / `TIME_WAIT` → `TIME_WAIT`
   - 其他类似的连字符与下划线变体同理。

2. **Agent 数据字段**（`agents` Map 中每一项）：
   ```js
   agents.set(id, {
     ws,           // WebSocket 连接（仅 ws 类型）
     name,         // 显示名称
     platform,     // 'linux' | 'win32' | 'darwin'
     arch,         // 'x64' | 'arm64' ...
     hostname,     // 机器主机名
     data,         // 最新一次的端口数据 payload
     lastSeen,     // Date.now() 时间戳
     type,         // 'ws' | 'ssh'
   });
   ```

3. **systemInfo 字段**：所有节点（含本地/Agent/SSH）上报的 `systemInfo` 应尽量包含：
   `hostname`, `platform`, `arch`, `cpus`, `totalMem`, `freeMem`, `uptime`, `loadAvg`, `networkInterfaces`。

## 5. 🎨 审美与前端质量

1. **坚持高颜值（WOW 效果）**：界面风格要求具备现代感、高端感。要充分利用深色模式的质感、高对比度的强调色（如 `LISTENING` 用鲜明的绿色，`TIME_WAIT` 用警告色），以及图标或 SVG 微动效。
2. **细致的微交互**：为元素的 Hover、点击以及数值的变动添加平滑的过渡动画(`transition`)。
3. **DOM 调和（Reconciliation）**：更新数据时使用增量渲染策略（对比现有 DOM 节点），避免整块 `innerHTML` 替换导致的闪烁。

## 6. 🗣️ AI 沟通与回复设定

1. **强制中文响应**：与用户的自然语言交流（解释代码、回答提问、报告进度）**必须全部使用中文**。
2. **全英文 Commit**：在生成 Git 提交信息（Commit Message）时，**必须全部使用英文**，并遵循常规规范（如 `feat: add new...`, `fix: resolve error in...`）。
3. **保持注释完整性**：除非专门要求重构，否则严禁在修改时清理或删除与所分配任务无关的其他代码和注释。

## 7. 🔄 工作流与代码提交约束

1. **开发前状态同步**：在动工（编写代码或推导方案）之前，必须优先拉取（`git fetch`）远端的最新代码，确保我们的工作基于最新的源版本。
2. **原子化提交 (Atomicity)**：
   - 尽量保持**每个 Commit 是一个独立的小模块**或修改（避免将毫不相干的代码改动塞进同一个 Commit 中）。
   - 确保**每个 PR 聚焦于一个独立的功能点**或 Bug 修复。

---
> **📝 To AI System (Antigravity)**: 
> You have successfully read the `Agents.md` rules. From now on, whenever working in this `port-monitor` codebase, enforce these best practices automatically.
