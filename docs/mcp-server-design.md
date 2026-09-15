# gh-app-token MCP Server 设计考虑

> 状态：设计考虑（未实现）。本文档回答「要不要做、做成什么样、有什么坑」，作为后续实现的起点。

## 1. 背景

当前 Agent 集成方式是第 4 块输出「Agent 提示词」：把取凭证命令和硬约束压成 ~18 行文本，让用户粘贴给 AI Agent。

这个方案的问题：

- **靠 Agent 自觉**。硬约束（只用 Basic、`-c` 位置、不落盘）写在提示词里，Agent 可能漏读或执行时打折扣
- **每次都要人肉搬运**。用户得先跑 exe，再复制提示词，再粘给 Agent
- **凭证经手聊天上下文**。提示词里含网络地址，进对话历史

MCP（Model Context Protocol）是 Agent 调用工具的标准通道，Claude Code / Cursor / Qoder 等都已原生支持。把「取凭证」做成 MCP 工具，上述三个问题都消失：Agent 主动调用、参数结构化、不依赖提示词纪律。

## 2. 两种方案的关系

| | 粘贴提示词（现状） | MCP Server |
|---|---|---|
| Agent 支持面 | 任何能收文本的 Agent | 仅支持 MCP 的 Agent |
| 约束执行力 | 提示词纪律，可能打折 | 工具端可直接返回「即用命令」，约束内置 |
| 用户操作 | 跑 exe → 复制 → 粘贴 | 配置一次 MCP，之后全自动 |
| 凭证路径 | 经过聊天上下文 | 只在工具调用结果里，可控 |

**结论：两者并存，不互相替代。** 提示词是兜底（面向不支持 MCP 的场景），MCP 是 Agent 场景的正路。

## 3. 工具面设计

倾向只暴露**一个工具**，YAGNI：

### `get_github_credential`

- **入参**：无必填参数。可选 `repo`（本次目标仓库，用于生成更精确的命令模板和收紧提示）
- **行为**：读取本仓库 `gh-app-token.ts` 的签发逻辑（复用 `loadConfig` → 签 JWT → 换 IAT），直接调用 GitHub API 申请一个新令牌
- **返回**（结构化 JSON）：
  - `authorization_header`（已 base64 的 Basic 值）
  - `expires_at` / `expires_at_local`
  - `repos`（可用仓库范围）
  - `commands`：预拼好的零残留命令模板（clone/pull/push），`-c` 位置、Basic 头全部内置正确
  - `agent_note`：一段 ~10 行的极简使用说明（沿用现有 Agent 提示词的压缩风格）

**刻意不做的**：

- 不做 `run_git` 工具（让 Agent 代执行 git）—— 工具面越宽，安全审查越难；Agent 本来就会跑 shell，给它正确命令即可
- 不暴露原始 token 的独立工具 —— `authorization_header` 已覆盖 git 场景；REST API 场景后续有真实需求再加
- 不做「缓存并复用令牌」—— 1 小时强制过期，签发成本为零，每次新签更安全

## 4. 架构

```
gh-app-token.ts（现有签发逻辑，抽成可复用模块）
        │
        ▼
mcp-server.ts（新增，Bun 运行，stdio transport）
  - 复用 MCP TypeScript SDK（@modelcontextprotocol/sdk）
  - 与 exe 共用同一份 .env + .pem（同目录约定不变）
  - 单进程单工具，无状态
```

关键取舍：

- **stdio transport**，不做 HTTP/SSE —— MCP Server 只服务本机 Agent，无需网络面
- **签发逻辑抽模块**而不是复制代码 —— `gh-app-token.ts` 目前是单文件 CLI；实现时把「配置加载 + JWT + IAT 签发」拆成 `core.ts`，CLI 和 MCP 两个入口共用。这是本次唯一涉及既有代码结构调整的点
- 分发方式：发布 MCP Server 依赖 Bun 编译产物（`gh-app-token-mcp.exe`），加进现有 release.yml 矩阵即可，不额外引入 npm 包发布流程

## 5. 安全考量

- **令牌留在本机**：stdio 通道，令牌只出现在 Agent 与本机进程之间，不经过任何第三方
- **权限边界不变**：MCP Server 能签出的令牌 = App 安装范围授权，不新增攻击面
- **配置即授权**：Agent 能触发签发，等价于任何本机进程都能跑 exe —— 没有（也无法）区分「用户手动」和「Agent 自动」。如果这不可接受，可在 .env 加 `MCP_ENABLED=0` 总开关
- **日志红线**：MCP Server 不得把令牌写进任何日志（stdout 是协议通道，日志走 stderr 且严禁包含凭证）

## 6. 开放问题（实现前需要确认）

1. **目标 Agent**：先支持哪一家？Claude Code 的 MCP 配置格式作为首个适配对象最简单（`claude mcp add`）
2. **并发**：多个 Agent 会话同时调签发 → 每次 new 一个令牌即可，无需锁，但要确认 GitHub 对 installation token 签发频率没有严格限流（已知速率限制宽松，实现时实测确认）
3. **`.env` 缺失时的行为**：返回结构化错误指导配置，还是静默失败？倾向前者（Agent 能把配置步骤转述给用户）
4. **是否复用网络命令**：MCP 场景下凭证直接进工具返回值，不需要 TextDB 中转；但若 Agent 与 MCP Server 不在同一台机器（远程场景）才有意义 —— 首版不做

## 7. 工作量估计

| 项 | 估计 |
|---|---|
| 签发逻辑抽成 `core.ts` | 小（纯搬运，CLI 行为不变） |
| `mcp-server.ts` + SDK 接入 | 中 |
| `get_github_credential` 返回结构 + 命令模板 | 小（复用现有 buildAgentPrompt/buildNetworkScript 的拼装逻辑） |
| release.yml 加 mcp 产物 | 小 |
| 实机验证（Claude Code / Qoder 各一） | 中 |

总体一个下午量级。建议在 v1.1.0 发布演练跑通后，作为 v1.2.0 的主题。
