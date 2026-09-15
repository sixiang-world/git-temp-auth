# git-temp-auth — 临时 GitHub 身份配置工具

运行一个脚本，自动配置好 GitHub token / username / email，到期自动撤销，再也不用手动管理 token。

## 解决什么问题

- 不想一遍遍去 GitHub 网页生成 token 再粘贴
- 不想生成永久 token 后面还要记得手动删
- 想临时授权某台电脑用几个小时，到期自动失效

## 工作原理

```
┌─────────────┐     API 创建      ┌──────────────────┐
│  母 token   │ ────────────────→ │ 短期子 token     │
│ (manage_    │                   │ (contents:write) │
│  tokens)    │ ←──────────────── │ 1~N 小时后过期    │
└─────────────┘     API 撤销      └──────────────────┘
       │                                    │
       │ 仅存本地配置文件                     │ 配置到 git credential
       │ (权限600)                          │ 用于 push/pull
       ▼                                    ▼
  不进入 git                          后台守护进程到期自动撤销
```

1. **母 token**：你一次性创建的 fine-grained PAT，仅拥有 `manage_tokens`（管理 token）权限，不碰仓库数据
2. **子 token**：脚本通过 API 自动创建的短期 fine-grained PAT，拥有 `contents:write` 权限，用于实际 git 操作
3. **守护进程**：`nohup` 后台运行，睡眠 N 小时后自动调用 API 撤销子 token + 清除本地 git 凭证

## 依赖

- bash 4+
- curl
- jq
- git

Linux / macOS 均可运行。Windows 用户可在 Git Bash 中运行。

**安装 jq：**
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

## 快速开始

### 1. 首次初始化（只需一次）

```bash
chmod +x git-temp-auth.sh
./git-temp-auth.sh init
```

按提示输入：
- **母 token**：在 [GitHub 新建 fine-grained token](https://github.com/settings/personal-access-tokens/new)，Permissions → Account permissions → **Manage personal access tokens** 设为 **Read and write**
- **git username**：你的 GitHub 用户名
- **git email**：你的 GitHub 邮箱

### 2. 启动临时授权

```bash
# 授权 5 小时
./git-temp-auth.sh start --hours 5

# 授权 1 小时（默认）
./git-temp-auth.sh start
```

运行后 git 全局配置自动完成，可以直接 `git push` / `git clone` 私有仓库。

### 3. 查看状态

```bash
./git-temp-auth.sh status
```

输出示例：
```
  Token ID     : 123456789
  创建时间(UTC): 2026-09-15T05:00:00Z
  过期时间(UTC): 2026-09-15T10:00:00Z
  守护进程 PID : 12345
  状态         : 运行中
  剩余时间     : 4 小时 32 分钟
```

### 4. 提前撤销（可选）

```bash
./git-temp-auth.sh revoke
```

即使不手动撤销，到期后守护进程也会自动执行相同操作。

## 安全说明

| 项目 | 说明 |
|------|------|
| 母 token 权限 | 仅 `manage_tokens`，无法读取/修改仓库内容 |
| 母 token 存储 | 本地 `config` 文件，权限 `600`，不进入 git 配置 |
| 子 token 权限 | `contents:write` + `metadata:read`，可按需在脚本中修改 |
| 子 token 过期 | GitHub 端设过期时间 + 本地守护进程双重保障 |
| 本地凭证清除 | 到期/撤销时自动删除 `~/.git-credentials` 中 github.com 条目 |
| user.name/email | 撤销时保留不清除（可能是你常用的全局配置） |

## 文件说明

```
git-temp-auth/
├── git-temp-auth.sh   # 主脚本（唯一可执行文件）
├── config             # 配置文件（init 后生成，含母 token，权限 600）
├── .state             # 运行状态（当前子 token 信息，权限 600）
├── .expire.log        # 守护进程日志
└── README.md          # 本文件
```

## 常见问题

**Q: 关闭终端后授权还在吗？**
A: 在。守护进程用 `nohup` 启动，不受终端关闭影响。

**Q: 重启电脑后呢？**
A: 守护进程会丢失，但子 token 在 GitHub 端仍会按设定时间自动过期。本地 git 凭证可能残留，可运行 `./git-temp-auth.sh revoke` 清理。

**Q: 母 token 安全吗？**
A: 母 token 只有管理 token 的权限，不能访问仓库。即使泄露，对方最多创建/删除 token，无法盗取代码。建议定期轮换。

**Q: 可以授权给 organization 仓库吗？**
A: 子 token 默认 `repository_selection: all`，包含你有权限的组织仓库。如需更精细控制，修改脚本中 `create_fine_grained_token` 函数的请求体。

**Q: 最短可以授权多久？**
A: GitHub API 理论上支持任意未来过期时间，实测 1 小时可用。如果 API 拒绝过短时间，会提示你尝试更长时长。

**Q: 怎么完全卸载？**
A: 删除整个 `git-temp-auth/` 目录，并手动检查 `~/.git-credentials` 和 `git config --global --list`。
