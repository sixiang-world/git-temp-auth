> ## ⚠️ 重要更正：本方案不可用
>
> 本文档描述的脚本（`git-temp-token.ts`）依赖 `POST /user/tokens` 端点来创建 token。
> **该端点不存在** —— GitHub 官方 REST API 中没有它，OpenAPI 规范里也没有，
> 实测真实账号调用返回 `404 Not Found`。
>
> 结论：**这个脚本的"自动创建 token"功能无法工作**（手动粘贴已有 token 的部分仍正常）。
> 请改用 **`gh-app-token.ts`**（GitHub App 方案），详见 `README-gh-app.md`。
>
> 验证过程见 `README.md` 顶部的说明。以下内容保留作为技术记录。

# git-temp-token — 临时 GitHub Token 生成器

双击 exe，输入配置，拿到一份**可直接复制到任何地方使用**的 token 配置信息。

**本程序不修改你本机的任何 git 配置** —— 不写凭证文件、不改 credential helper、不起后台进程。它只负责生成信息给你复制。

## 为什么是它

| 场景 | 用它 |
|------|------|
| 想临时授权**另一台**机器 / 容器 / 服务器 | ✅ 生成信息，粘过去就行 |
| 只想拿到 token 值填到别处（CI、面板、同事） | ✅ |
| 想在本机自动配好 git 并能自动撤销 | ❌ 用 `git-temp-auth.ts` |

## 快速开始

### 1. 编译 exe

```bash
bun install
bun run build
```

产物：`dist/git-temp-token.exe`（约 86 MB，自带运行时，**目标机器无需装任何东西**）

### 2. 首次运行

双击 `git-temp-token.exe`。若旁边没有 `.env`，它会**自动生成一份模板**并告诉你填什么。

用记事本打开同目录的 `.env`，填三项：

```ini
GITHUB_MASTER_TOKEN=github_pat_xxxxxxxxxxxx
GIT_USERNAME=your-github-username
GIT_EMAIL=your-email@example.com
GIT_TEMP_HOURS=1
```

### 3. 再次双击

窗口会显示并**自动复制到剪贴板**：

```
──────────────────────────────────────────────────────────
  生成成功
──────────────────────────────────────────────────────────
  Token ID      : 424242
  有效期        : 4 小时
  过期时间(UTC) : 2026-09-15T09:57:13Z
  过期时间(本地): 2026-09-15 17:57:13
  Git 用户      : your-name <your@email.com>

[INFO]  完整配置信息已复制到剪贴板，可直接粘贴到任何地方

──────────────────────────────────────────────────────────
  配置信息（可直接复制）
──────────────────────────────────────────────────────────
# ====== GitHub 临时 Token 配置信息 ======
# 有效期   : 4 小时
# 过期时间 : 2026-09-15T09:57:13Z (UTC)
# 本地时间 : 2026-09-15 17:57:13

# --- 基本信息（复制到任意地方使用） ---
Token    : github_pat_xxx
Username : your-name
Email    : your@email.com
Expires  : 2026-09-15T09:57:13Z

# --- git 配置命令（在目标机器执行） ---
git config --global user.name "your-name"
git config --global user.email "your@email.com"
git config --global credential.helper store

# --- 凭证文件（目标机器） ---
# PowerShell:
Set-Content -Path "$HOME\.git-credentials" -Value "https://x-access-token:github_pat_xxx@github.com" -Encoding ascii
# Bash / Git Bash:
echo 'https://x-access-token:github_pat_xxx@github.com' > ~/.git-credentials

# --- 一行式（PowerShell，直接粘贴） ---
git config --global user.name "your-name"; git config --global user.email "your@email.com"; git config --global credential.helper store; Set-Content -Path "$HOME\.git-credentials" -Value "https://x-access-token:github_pat_xxx@github.com" -Encoding ascii

──────────────────────────────────────────────────────────
  本程序未修改你本机的任何 git 配置
──────────────────────────────────────────────────────────

按 Enter 键退出...
```

把这段粘到目标机器上执行，或者只取 Token 那一行填到别处。

## 命令行用法

双击等价于无参数运行。也可以在终端里用：

```bash
./git-temp-token.exe                # 默认时长（取 .env 的 GIT_TEMP_HOURS）
./git-temp-token.exe --hours 5      # 授权 5 小时
./git-temp-token.exe --json         # 输出 JSON，便于脚本处理
./git-temp-token.exe --no-clipboard # 不写剪贴板，仅显示
./git-temp-token.exe --help         # 帮助
```

`--json` 输出示例：

```json
{
  "token": "github_pat_xxx",
  "token_id": "424242",
  "username": "your-name",
  "email": "your@email.com",
  "expires_at": "2026-09-15T09:57:13Z",
  "expires_at_local": "2026-09-15 17:57:13",
  "hours": 4
}
```

## 母 token 怎么来

1. 打开 https://github.com/settings/personal-access-tokens/new
2. **Token type** 选 `Fine-grained`
3. **Repository access** 选 `All repositories`（或按需）
4. **Permissions** → **Account permissions** → **Manage personal access tokens** → `Read and write`
5. 过期时间可设较长（如 1 年）—— 它权限极小，只能创建/删除 token，碰不到仓库代码
6. 生成后把 token 填进 `.env` 的 `GITHUB_MASTER_TOKEN`

## 环境变量

| 变量 | 说明 |
|------|------|
| `GITHUB_API_BASE` | 覆盖 API 地址（GitHub Enterprise / 测试用） |
| `GTT_NO_PAUSE` | 设为任意值可跳过「按 Enter 退出」 |
| `NO_COLOR` | 关闭彩色输出 |

## 安全说明

| 项目 | 说明 |
|------|------|
| 子 token 权限 | `contents:write` + `metadata:read`，可改脚本调整 |
| 子 token 过期 | **由 GitHub 服务端强制**，到点自动失效，不依赖本机进程 |
| 母 token 存储 | 本地 `.env`（已在 `.gitignore` 中），不会被提交 |
| 本机副作用 | **无** —— 不碰 git config、不写凭证文件、不留状态文件 |

> 关于过期：token 的 `expires_at` 在创建时就交给了 GitHub，到期由 GitHub 服务器自动撤销。
> 哪怕你关机、重启、把 exe 删了，token 依然会到点失效。这点无需担心。

## 为什么用 Bun 而不是 Go

两者都能编译成单文件 exe，实际差异：

| 项目 | Bun | Go |
|------|-----|-----|
| 体积 | ~86 MB | ~5-8 MB |
| 编译速度 | < 1 秒 | 数秒 |
| 开发成本 | 复用现有 TS | 需从零重写 |

体积是 Bun 唯一劣势。但单文件不联网分发时，86 MB 完全可用，而**复用已有逻辑省下的重写成本远大于体积收益**，故选 Bun。

## 踩坑记录（编译 exe 必看）

1. **`process.argv[0]` 在编译后返回字符串 `"bun"`**，`argv[1]` 是虚拟路径 `B:/~BUN/root/xxx.exe`。
   定位 exe 只能用 `process.execPath`。
2. **Bun 的 `.env` 自动加载是按「当前工作目录」找的**，不是 exe 所在目录。
   从别处调用 exe 会静默读不到配置。本程序改为用 `execPath` 推导目录后**显式加载**。
3. 双击后窗口会瞬间关闭，必须等待按键，否则来不及复制。
4. 剪贴板中文乱码：不能把内容通过 stdin 喂给 PowerShell（按 GBK 解码）。
   本程序先写 UTF-8 临时文件，再用 `[System.IO.File]::ReadAllText(..., UTF8)` 读回。

## 相关文件

```
git-temp-auth/
├── git-temp-token.ts        # 本工具源码（纯生成器）
├── git-temp-auth.ts         # 完整版：自动配置本机 git + 到期撤销
├── git-temp-auth.sh         # 完整版 Shell 实现
└── dist/
    └── git-temp-token.exe   # 编译产物（gitignore 忽略）
```
