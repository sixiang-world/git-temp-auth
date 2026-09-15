# git-temp-auth — 临时 GitHub 身份配置工具

运行一个脚本，自动配置好 GitHub token / username / email，到期自动撤销，再也不用手动管理 token。

提供两个版本：

| 版本 | 文件 | 依赖 | 适用 |
|------|------|------|------|
| **Bun 版（推荐）** | `git-temp-auth.ts` | bun 1.x + git | Windows / macOS / Linux |
| Shell 版 | `git-temp-auth.sh` | bash + curl + jq + git | Linux / macOS / Git Bash |

Bun 版针对 Windows 做了专门优化：无需 jq/curl、自动读取 `.env`、输出可直接粘贴的 PowerShell 命令并自动复制到剪贴板。

## 解决什么问题

- 不想一遍遍去 GitHub 网页生成 token 再粘贴
- 不想生成永久 token 后面还要记得手动删
- 想临时授权某台电脑用几个小时，到期自动失效

## 快速开始（Bun 版）

### 1. 创建 `.env` 配置

复制下面内容到项目根目录的 `.env`：

```ini
# 母 token：GitHub fine-grained PAT，仅需 Manage personal access tokens = Read and write
# 创建地址 https://github.com/settings/personal-access-tokens/new
GITHUB_MASTER_TOKEN=github_pat_xxxxxxxxxxxx

# git 提交身份
GIT_USERNAME=your-github-username
GIT_EMAIL=your-email@example.com

# 默认授权时长（小时），可被 --hours 覆盖
GIT_TEMP_HOURS=1
```

或者运行交互式初始化，它会自动生成模板并写入：

```bash
bun git-temp-auth.ts init
```

### 2. 运行（默认读取 .env，无需任何参数）

```bash
bun git-temp-auth.ts
```

启动后 Bun 会自动加载同目录 `.env`，脚本随即：

1. 调 GitHub API 创建短期 token
2. 写好 git 全局 `user.name` / `user.email` / credential
3. **打印一段一键粘贴命令，并自动复制到剪贴板**

输出示例：

```
──────────────────────────────────────────────
  临时授权已启用
──────────────────────────────────────────────
  Token ID      : 123456789
  有效期        : 5 小时
  过期时间(UTC) : 2026-09-15T10:00:00Z
  过期时间(本地): 2026-09-15 18:00:00
  Git 用户      : your-name <your@email.com>
  守护进程      : PID 12345

[INFO]  git 已配置完成，可直接 git push / git clone

──────────────────────────────────────────────
  一键粘贴配置命令
──────────────────────────────────────────────

# ===== git-temp-auth 一键配置 =====
# 用户     : your-name <your@email.com>
# 过期时间 : 2026-09-15T10:00:00Z (UTC)
# 本地时间 : 2026-09-15 18:00:00

git config --global user.name "your-name"
git config --global user.email "your@email.com"
git config --global credential.helper store
git config --global --unset temp-auth.prevCredentialHelper
Set-Content -Path "C:\Users\you\.git-credentials" -Value "https://x-access-token:github_pat_xxx@github.com" -Encoding ascii

# 过期后手动清理：
# git config --global --unset credential.helper

[INFO]  ✓ 以上命令已复制到剪贴板，直接在目标终端 Ctrl+V 回车即可
```

把这段内容粘贴到**另一台机器**的终端里回车，即可完成同样的配置（token / username / email / 过期时间都已带好）。

### 3. 常用命令

```bash
bun git-temp-auth.ts                  # 创建临时授权（默认时长取 .env）
bun git-temp-auth.ts --hours 5        # 授权 5 小时
bun git-temp-auth.ts status           # 查看状态与剩余时间
bun git-temp-auth.ts revoke           # 提前撤销
bun git-temp-auth.ts init             # 交互式生成/更新 .env
bun git-temp-auth.ts help             # 帮助
```

也可用 npm scripts：

```bash
bun run start      # 等价于 bun git-temp-auth.ts
bun run status
bun run revoke
bun run usage
```

### 4. 快捷方式（可选）

**Windows** — 新建 `git-temp-auth.cmd` 放到项目目录或 PATH：

```bat
@echo off
bun "%~dp0git-temp-auth.ts" %*
```

之后直接 `git-temp-auth --hours 5` 即可。

**macOS / Linux** — 加个 alias：

```bash
alias gta='bun /path/to/git-temp-auth.ts'
```

## Bun 版命令选项

| 选项 | 说明 |
|------|------|
| `--hours N` | 授权时长（小时），默认取 `.env` 的 `GIT_TEMP_HOURS` |
| `--no-clipboard` | 不把一键命令写入剪贴板（仅打印） |
| `--yes`, `-y` | 跳过「覆盖已有授权」的确认提示 |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_MASTER_TOKEN` | 是 | 母 token，仅需 `manage_tokens` 权限 |
| `GIT_USERNAME` | 是 | git 提交用户名 |
| `GIT_EMAIL` | 是 | git 提交邮箱 |
| `GIT_TEMP_HOURS` | 否 | 默认授权时长，默认 `1` |
| `GITHUB_API_BASE` | 否 | 覆盖 API 地址（用于 GitHub Enterprise / 测试） |
| `NO_COLOR` | 否 | 设为任意值可关闭彩色输出 |

## 工作原理

```
┌─────────────┐     API 创建      ┌──────────────────┐
│  母 token   │ ────────────────→ │ 短期子 token     │
│ (manage_    │                   │ (contents:write) │
│  tokens)    │ ←──────────────── │ 1~N 小时后过期    │
└─────────────┘     API 撤销      └──────────────────┘
       │                                    │
       │ 仅存本地 .env                       │ 配置到 git credential
       │ (权限600)                          │ 用于 push/pull
       ▼                                    ▼
  不进入 git                          后台守护进程到期自动撤销
```

1. **母 token**：你一次性创建的 fine-grained PAT，仅拥有 `manage_tokens`（管理 token）权限，不碰仓库数据
2. **子 token**：脚本通过 API 自动创建的短期 fine-grained PAT，拥有 `contents:write` 权限，用于实际 git 操作
3. **守护进程**：以分离进程（detached）后台运行，睡眠 N 小时后自动调用 API 撤销子 token + 清除本地 git 凭证

### Bun 版与 Shell 版的差异

| 项目 | Shell 版 | Bun 版 |
|------|----------|--------|
| 依赖 | bash + curl + jq + git | bun + git |
| 配置来源 | `config` 文件 | `.env`（Bun 自动加载） |
| 后台守护 | `nohup bash ... &` | `spawn(detached:true)` + `unref()` |
| 一键粘贴命令 | 无 | 有，且自动进剪贴板 |
| 原 credential.helper | 直接覆盖 | **记录并在撤销时还原**（如 `gh auth git-credential`） |
| HTTP 请求 | curl 子进程 | 内置 `fetch` |
| Windows 支持 | 需 Git Bash + jq.exe | 原生 |

## 安全说明

| 项目 | 说明 |
|------|------|
| 母 token 权限 | 仅 `manage_tokens`，无法读取/修改仓库内容 |
| 母 token 存储 | 本地 `.env`，权限 `600`，不进入 git 配置，已在 `.gitignore` 中 |
| 子 token 权限 | `contents:write` + `metadata:read`，可按需在脚本中修改 |
| 子 token 过期 | GitHub 端设过期时间 + 本地守护进程双重保障 |
| 本地凭证清除 | 到期/撤销时自动删除 `~/.git-credentials` 中 github.com 条目 |
| credential.helper | 撤销时还原为你原来的设置（Bun 版特性） |
| user.name/email | 撤销时保留不清除（可能是你常用的全局配置） |

## 文件说明

```
git-temp-auth/
├── git-temp-auth.ts    # Bun 版主脚本（推荐）
├── git-temp-auth.sh    # Shell 版主脚本
├── .env                # 配置文件（含母 token，权限 600，已被 .gitignore 忽略）
├── .state              # 运行状态（当前子 token 信息，权限 600）
├── .expire.log         # 守护进程日志
├── package.json        # npm scripts（bun run start / status / revoke）
└── README.md           # 本文件
```

## Shell 版快速开始

```bash
chmod +x git-temp-auth.sh
./git-temp-auth.sh init              # 配置母 token、username、email
./git-temp-auth.sh start --hours 5   # 授权 5 小时
./git-temp-auth.sh status            # 查看状态
./git-temp-auth.sh revoke            # 提前撤销
```

Shell 版配置保存在 `config` 文件而非 `.env`。

**安装 jq（Shell 版需要）：**

```bash
# macOS
brew install jq

# Debian/Ubuntu
sudo apt install jq

# CentOS/RHEL
sudo yum install jq

# Windows (Git Bash) — 下载 jq.exe 放到 Git 的 usr/bin 目录
# https://jqlang.github.io/jq/download/
```

## 常见问题

**Q: Bun 版为什么不需要参数就读到了配置？**
A: Bun 运行时启动时会自动加载项目根目录的 `.env`。脚本另外做了一次自解析兜底，所以即使换目录或其他方式启动也能读到。

**Q: 关闭终端后授权还在吗？**
A: 在。守护进程以分离进程方式启动（`detached: true` + `unref()`），不受终端关闭影响。

**Q: 重启电脑后呢？**
A: 守护进程会丢失，但子 token 在 GitHub 端仍会按设定时间自动过期。本地 git 凭证可能残留，可运行 `bun git-temp-auth.ts revoke` 清理。

**Q: 会覆盖我原来的 git credential helper 吗？**
A: Bun 版会先记录你原来的 `credential.helper`（例如 `gh auth git-credential`），撤销时自动还原；Shell 版则直接覆盖，不还原。

**Q: 母 token 安全吗？**
A: 母 token 只有管理 token 的权限，不能访问仓库。即使泄露，对方最多创建/删除 token，无法盗取代码。建议定期轮换。

**Q: 可以授权给 organization 仓库吗？**
A: 子 token 默认 `repository_selection: all`，包含你有权限的组织仓库。如需更精细控制，修改脚本中 `createFineGrainedToken` 函数的请求体。

**Q: 最短可以授权多久？**
A: GitHub API 理论上支持任意未来过期时间，实测 1 小时可用。如果 API 拒绝过短时间，会提示你尝试更长时长。

**Q: 剪贴板没生效？**
A: 加 `--no-clipboard` 只用打印模式，手动复制即可。Windows 下会自动尝试 PowerShell，失败则退回 `clip.exe`（此时中文可能乱码，但命令本身有效）。

**Q: 怎么完全卸载？**
A: 删除整个 `git-temp-auth/` 目录，并手动检查 `~/.git-credentials` 和 `git config --global --list`。

