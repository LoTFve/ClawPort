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
3. **WebSocket 核心机制**：
   - 系统存在两套 WebSocket 服务：`wssBrowser` 负责将整合后的数据推给浏览器前端；`wssAgent`（路径 `/agent`）负责接收远程边缘服务器采集上来的数据。
   - 修补通信逻辑时，注意维持这种数据流动的单向与隔离。

## 2. 💻 跨平台与命令兼容性

由于 `agent.js` 会被部署在各种未知的远程机器上：
1. **指令分发**：任何涉及系统底层查询动作（如端口信息、进程状态、硬件负载），在编写代码时**必须进行操作系统环境（Windows vs Linux / macOS）的判别**。
    - Windows 下优先使用 `netstat -ano` 和 `tasklist`。
    - Linux 下优先使用 `ss` 或 `netstat -tunap`。
2. **容错性**：底层 `exec` 命令或者 WebSocket 会话极易出现网络抖动、进程不存在或权限不足，必须有严谨的 `catch` 或 `on('error')` 处理，确保单个错误不会阻塞掉主线程。

## 3. 🎨 审美与前端质量

1. **坚持高颜值（WOW 效果）**：界面风格要求具备现代感、高端感。要充分利用深色模式的质感、高对比度的强调色（如 `LISTENING` 用鲜明的绿色，`TIME_WAIT` 用警告色），以及图标或 SVG 微动效。
2. **细致的微交互**：为元素的 Hover、点击以及数值的变动添加平滑的过渡动画(`transition`)。

## 4. 🗣️ AI 沟通与回复设定

1. **强制中文响应**：与用户的自然语言交流（解释代码、回答提问、报告进度）**必须全部使用中文**。
2. **全英文 Commit**：在生成 Git 提交信息（Commit Message）时，**必须全部使用英文**，并遵循常规规范（如 `feat: add new...`, `fix: resolve error in...`）。
3. **保持注释完整性**：除非专门要求重构，否则严禁在修改时清理或删除与所分配任务无关的其他代码和注释。

---
> **📝 To AI System (Antigravity)**: 
> You have successfully read the `Agents.md` rules. From now on, whenever working in this `port-monitor` codebase, enforce these best practices automatically.
