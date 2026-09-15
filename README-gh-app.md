# gh-app-token — GitHub App 短期凭证签发工具

用 GitHub App 换取 **1 小时有效**的临时访问令牌，输出**零残留**的 git 命令。

双击即用，单文件 exe，不修改本机任何 git 配置。

---

## 一、先说清楚：为什么必须用 GitHub App

你在别处可能见过「创建母 token → 用它自动生成子 token」的说法。**这条路在 GitHub 上不存在。**

我实测验证过：

| 验证项 | 结果 |
|--------|------|
| `POST /user/tokens`（创建 PAT 的端点） | **404，端点不存在** |
| 该端点是否在 GitHub 官方 OpenAPI 规范中 | **不在** |
| 官方 Account permissions 完整 20 项里有无「Manage personal access tokens」 | **没有** |
| `/orgs/{org}/personal-access-tokens` 等端点 | 存在，但官方规范原文写明 **"Only GitHub Apps can use this endpoint"**，且只能「列示/批准/撤销」，**不能创建** |

**根本原因**：GitHub 把 PAT 定义为「人类用户身份的代表」，创建 PAT 必须经过 Web 登录（常需 MFA）。为防止泄露的低权限令牌静默提权、生成难以追踪的后门令牌，**创建 PAT 的能力被故意排除在 API 之外**。

**官方唯一支持的机器身份方案就是 GitHub App。** 本工具走这条路。

---

## 二、工作原理

```
┌──────────────────┐   本地 RS256 签名    ┌─────────────────┐
│ App 的 RSA 私钥   │ ──────────────────→ │  JWT (10分钟)    │
└──────────────────┘                     └─────────────────┘
                                                  │
                                                  │ POST /app/installations/{id}/access_tokens
                                                  ▼
                                         ┌─────────────────────┐
                                         │ 安装访问令牌 IAT     │
                                         │ ghs_ 前缀，1 小时    │
                                         └─────────────────────┘
                                                  │
                                                  │ 输出 git -c 命令
                                                  ▼
                                         ┌─────────────────────┐
                                         │ 零残留使用           │
                                         │ 不写 .git/config     │
                                         └─────────────────────┘
```

三个关键点（均已实测验证）：

1. **JWT**：用私钥本地签 RS256，`iat` 提前 60 秒防时钟漂移，`exp` 最长 10 分钟
2. **IAT**：官方文档原文 *"The installation access token will expire after 1 hour."* —— **硬编码 1 小时，无法通过参数调整**
3. **零残留**：用 `git -c http.extraHeader=...` 注入，只在单次进程内存生效，不落盘

### ⚠️ 必须知道的坑：新令牌只认 Basic 认证，不认 Bearer

GitHub 自 2026 年 4 月起对新签发的安装令牌推行 **stateless 格式**（就是你现在拿到的这种）。
判断方法：看 `ghs_` 后面有没有点号。

| 格式 | 形态 | 长度 | 认证方式 |
|------|------|------|---------|
| **stateless（新，当前）** | `ghs_<appid>_<JWT>`，**含两个点** | ~383 字符 | **只认 HTTP Basic** |
| stateful（旧） | `ghs_` + 不透明短串，**无点号** | ~40 字符 | Bearer / Basic 都行 |

实测对照（同一个令牌，跑 `git ls-remote`）：

```
git -c http.extraHeader="Authorization: Bearer <token>"  → 失败（401 / 提示输入用户名）
git -c http.extraHeader="Authorization: token <token>"   → 失败（同上）
git -c http.extraHeader="Authorization: Basic <base64>"  → 成功 ✅
git clone https://x-access-token:<token>@github.com/...  → 成功 ✅
```

**所以本工具直接给你算好 base64 的 Basic 头值**，粘贴即用，不用自己编码。

Basic 的拼接规则：

```
base64( "x-access-token" + ":" + 原始令牌 )
```

本工具输出的 `Authorization: Basic xxxx` 里的 `xxxx` 就是它。

参考：<https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/>

### ⚠️ 第二个坑：`-c` 的位置决定了令牌会不会落盘

Git 对 `-c` 的处理按位置区分，**这直接决定令牌安全**：

```bash
git -c http.extraHeader=... clone <url>   # ✅ 仅本次命令生效，不落盘
git clone -c http.extraHeader=... <url>   # ❌ 被当作 clone 的选项，写进新仓库 .git/config
```

第二种写法会在 `.git/config` 里留下：

```ini
[http]
    extraheader = Authorization: Basic <明文 base64 令牌>
```

这个文件会随项目一起被打包/上传，令牌直接泄露。**本工具输出的所有命令都已把 `-c` 放在正确位置。**

---

## 三、1 小时限制（重要）

| 凭证 | 前缀 | 有效期 | 可配置 |
|------|------|--------|--------|
| JWT | — | ≤10 分钟 | 否 |
| **安装访问令牌 IAT** | `ghs_` | **强制 1 小时** | **否** |
| 用户访问令牌 UAT | `ghu_` | 8 小时 | 否（且需浏览器授权） |

**这条 1 小时上限改不了。** 你原本期望的「1~24 小时可调」在 GitHub App 方案下无法实现。

换个角度看，这反而是好事：凭证越短命，泄露后的风险窗口越小。需要更长时间就再跑一次工具，成本极低。

> 如果你**必须**要更长有效期的 token，那只能手动去 GitHub 网页创建 PAT —— 见文末「方案 B」。

---

## 四、配置步骤

### 1. 创建 GitHub App

1. 打开 https://github.com/settings/apps/new
2. **取消勾选 Webhook**（本工具是单向调用，不需要回调）
3. **Repository permissions** 设置：
   - `Contents` → **Read and write**
   - `Metadata` → **Read-only**（必选，会自动带上）
4. 点 **Create GitHub App**
5. 记录页面顶部的 **App ID**（一串数字）

### 2. 下载私钥

在 App 页面拉到最下方，点 **Generate a private key**，下载 `.pem` 文件。

把这个文件放到本程序同目录。

### 3. 安装到仓库

左侧边栏 → **Install App** → 选择安装到你的账号 → 选择目标仓库。

安装完成后看浏览器地址栏：

```
https://github.com/settings/installations/12345678
                                          ^^^^^^^^
                                          这就是 Installation ID
```

### 4. 填写 `.env`

首次运行程序会自动生成 `.env` 模板。填入：

```ini
APP_ID=123456
INSTALLATION_ID=12345678
APP_PRIVATE_KEY_PATH=app-private-key.pem

# App 的 slug（可选，填了才会生成 bot 提交身份）
APP_SLUG=my-token-tool

# 可选：限定只能访问这些仓库
TARGET_REPOS=owner/repo1,owner/repo2
```

### 5. 校验配置

```bash
bun run app:check
```

会检查私钥能否正常签名、配置是否完整。

### 6. 正式运行

```bash
bun run app
```

或编译成 exe 双击运行：

```bash
bun run build     # 产出 dist/gh-app-token.exe
```

---

## 五、输出示例

```
────────────────────────────────────────────────────────────
  签发成功
────────────────────────────────────────────────────────────
  令牌前缀      : ghs_4951418_...
  过期时间(UTC) : 2026-09-15T10:58:34Z
  过期时间(本地): 2026-09-15 18:58:34
  有效时长      : 1 小时（GitHub 强制）
  仓库范围      : 安装范围内全部
  Bot 身份      : gen-temp-token[bot]

[INFO]  完整配置已复制到剪贴板

────────────────────────────────────────────────────────────
  配置信息（可直接复制）
────────────────────────────────────────────────────────────
# ====== GitHub App 短期访问凭证 ======
# 过期时间(UTC) : 2026-09-15T10:58:34Z
# 过期时间(本地): 2026-09-15 18:58:34
# 有效期        : 1 小时（GitHub 强制，不可配置）

# --- 原始 Token（ghs_ 开头，1 小时后自动失效）---
ghs_4951418_eyJhbGciOiJFUzI1NiIs...

# --- Authorization 头（已 base64，粘贴即用）-----------------
# 注意：不要用 Authorization: Bearer <token>
#       新版 ghs_ 令牌只认 Basic 认证，Bearer 会被拒（401）
Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzXzQ5NTE0MThf...

# --- 用法：零残留（推荐）-------------------------------------
$env:GH_TEMP_TOKEN = "eC1hY2Nlc3MtdG9rZW46Z2hz..."
git -c http.extraHeader="Authorization: Basic $env:GH_TEMP_TOKEN" -c user.name="gen-temp-token[bot]" -c user.email="329479613+gen-temp-token[bot]@users.noreply.github.com" clone https://github.com/sixiang-world/jvs-openclaw-workspace.git
```

---

## 六、为什么不用 `https://token@github.com` 内嵌写法

**这是一个容易踩的安全坑。**

如果用 `git clone https://x-access-token:TOKEN@github.com/owner/repo.git`，Git 会把远程 URL **原样写进项目目录的 `.git/config`**：

```ini
[remote "origin"]
    url = https://x-access-token:ghs_xxxxx@github.com/owner/repo.git
```

Token 就这样以明文留在磁盘上。项目目录一旦被打包、分享、同步，凭证立刻泄露。

用 `git -c http.extraHeader=...` 则只在**单次进程的内存**里生效，命令结束即消失：

```
$ GIT_TRACE_CURL=1 git -c http.extraHeader="Authorization: Basic xxx" ls-remote ...
=> Send header: Authorization: Basic <redacted>
```

实测确认（本机真实 App，2026-09-15）：

| 检查项 | 结果 |
|--------|------|
| `clone` + `push` 全程使用 Basic 头 | ✅ 成功 |
| `.git/config` 是否含 `extraheader` / 令牌 | ✅ 无 |
| 扫描整个 `.git` 目录是否含令牌字节 | ✅ 无 |
| `git remote -v` 的 URL | ✅ 不含令牌 |

---

## 七、命令行选项

```bash
gh-app-token.exe                # 默认：申请令牌并输出
gh-app-token.exe --check        # 仅校验配置，不申请
gh-app-token.exe --json         # JSON 输出（含 authorization_header 字段）
gh-app-token.exe --no-clipboard # 不写剪贴板
gh-app-token.exe --help         # 帮助
```

`--json` 输出示例（可用于脚本集成）：

```json
{
  "token": "ghs_4951418_eyJ...",
  "authorization_header": "Basic eC1hY2Nlc3MtdG9rZW46Z2hz...",
  "expires_at": "2026-09-15T10:58:34Z",
  "expires_at_local": "2026-09-15 18:58:34",
  "token_type": "installation_access_token",
  "prefix": "ghs_",
  "is_stateless": true,
  "permissions": { "contents": "write", "metadata": "read" },
  "repository_selection": "all",
  "bot_name": "gen-temp-token[bot]",
  "bot_email": "329479613+gen-temp-token[bot]@users.noreply.github.com"
}
```

直接取 `authorization_header` 就能塞进任何 HTTP 客户端的 `Authorization` 头：

```bash
HEADER=$(gh-app-token.exe --json --no-clipboard | jq -r .authorization_header)
curl -H "$HEADER" https://api.github.com/installation/repositories
```

环境变量：

| 变量 | 说明 |
|------|------|
| `GITHUB_API_BASE` | 覆盖 API 地址（GitHub Enterprise） |
| `GTT_NO_PAUSE` | 跳过「按 Enter 退出」 |
| `NO_COLOR` | 关闭彩色输出 |

---

## 八、安全须知

| 项目 | 说明 |
|------|------|
| **私钥风险** | `.pem` 私钥若内嵌进 exe，理论上可被逆向提取。**已加入 `.gitignore`，切勿提交** |
| 权限越小越好 | 只给目标仓库必要的 `Contents` 权限，别开组织级大权限 |
| 爆炸半径 | 即便私钥泄露，攻击者最多拿到你授予该 App 的那几个仓库的权限 |
| 令牌短命 | 1 小时强制过期，由 GitHub 服务端执行，不依赖本机进程 |
| 零副作用 | 不写 git 配置、不改 credential helper、不留后台进程 |
| **`-c` 位置** | 必须写在子命令前，否则令牌落盘（见第二节第二个坑） |
| **认证方式** | 新版令牌只认 Basic，用 Bearer 会被拒（见第二节第一个坑） |

### 本机真实实测记录（2026-09-15）

App `gen-temp-token`（App ID `4951418`，Installation `161872917`）端到端验证：

| 验证项 | 结果 |
|--------|------|
| JWT 生成 + 私钥自检 | ✅ |
| `POST /app/installations/161872917/access_tokens` | ✅ 200，返回 `ghs_` 令牌 |
| 令牌对 REST API（Bearer） | ✅ 可列出 37 个仓库 |
| 令牌对 git 协议（Basic 头） | ✅ `ls-remote` / `clone` / `push` 全部成功 |
| 令牌对 git 协议（Bearer 头） | ❌ 401 —— 预期行为，非缺陷 |
| `clone` 后 `.git/config` 残留检查 | ✅ 无 |
| `push` 后远端分支创建 | ✅ 成功，随后已删除 |
| 扫描 `.git` 全目录令牌字节 | ✅ 无 |
| `git remote -v` URL | ✅ 不含令牌 |

---

## 九、排错

**Q: git 报 `could not read Username for 'https://github.com'` / 401**

这几乎总是**用了 `Bearer` 而不是 `Basic`**。

新版 `ghs_` 令牌（含点号的那种）只接受 HTTP Basic 认证。检查你的命令：

```bash
# ❌ 错
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone ...

# ✅ 对（$GH_TEMP_TOKEN 是程序输出的 base64 串，不是原始令牌）
git -c http.extraHeader="Authorization: Basic $GH_TEMP_TOKEN" clone ...
```

注意区分：`$env:GH_TEMP_TOKEN` 存的是**程序输出的 base64 值**，不是 `ghs_` 开头的原始令牌。
如果你只拿到原始令牌，需要自己拼：

```bash
# Bash
B64=$(printf 'x-access-token:%s' "$RAW_TOKEN" | base64 -w0)

# PowerShell
$B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x-access-token:$RAW_TOKEN"))
```

**Q: 令牌明明没写进配置，却出现在 `.git/config` 里了**

检查你的 `-c` 位置：

```bash
git -c http.extraHeader=... clone <url>   # ✅ 临时
git clone -c http.extraHeader=... <url>   # ❌ 落盘
```

已经落盘的话，清理：

```bash
git config --unset http.extraheader    # 在仓库目录内执行
```

**Q: 报 `A JSON web token could not be decoded`**

这个错误**有两种含义**，注意区分：

| 情况 | GitHub 返回的 message |
|------|---------------------|
| JWT 格式畸形 | `Bad credentials` |
| JWT 格式正确，但 App 不存在/验签失败 | `A JSON web token could not be decoded` |

收到后者说明**你的 JWT 构造是对的**，问题在于：
1. `APP_ID` 写错了（写成了 Client ID，或 App 已被删除）
2. 私钥与这个 App 不匹配
3. 本机系统时间偏差过大

**Q: 报 `Integration not found`（404）**

这个错误**也有两种含义**：

| 情况 | 说明 |
|------|------|
| App 不存在 | `APP_ID` 填错了（比如填成 Client ID），GitHub 查不到这个 App |
| 安装不存在 | `INSTALLATION_ID` 填错，或 App 没装到目标仓库 |

**注意 App ID 和 Client ID 是两个不同的东西**——创建 App 后页面顶部显示的是 App ID（纯数字如 `4951418`），
下面的 Client ID 形如 `Iv23li83...`（字母数字混合）。本工具只认 **App ID**。

`INSTALLATION_ID` 也不是 App ID，而是安装完成后浏览器地址栏里那串数字：
`https://github.com/settings/installations/161872917` → `161872917`。

**Q: 编译成 exe 后读不到 `.env`**

本程序用 `process.execPath` 定位 exe 所在目录，`.env` 必须和 **exe 放在同一目录**。
（不能用 `process.argv[0]` —— 编译后它返回字符串 `"bun"`；也不能依赖工作目录。）

**Q: 私钥自检失败**

确认文件是从 GitHub App 页面下载的 PEM 格式私钥（`-----BEGIN RSA PRIVATE KEY-----`
或 `-----BEGIN PRIVATE KEY-----`），且未被编辑器改动换行符。

**Q: token 能读 API 但 git 操作 401**

先用 curl 分别验证两条通道，快速定位是「令牌无效」还是「认证方式不对」：

```bash
TOKEN=$(...)
# 通道 1：REST API（Bearer 是正确的）
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/installation/repositories

# 通道 2：git 协议（必须用 Basic）
curl -u "x-access-token:$TOKEN" "https://github.com/owner/repo.git/info/refs?service=git-upload-pack"
```

若通道 1 通、通道 2 用 Bearer 不通 —— 这是**预期的**，换成 Basic 即可。

---

## 十、替代方案（如果 GitHub App 不可行）

**方案 B：手动创建 PAT**

如果 GitHub App 因组织策略无法使用，就只能手动走网页：
1. https://github.com/settings/personal-access-tokens/new
2. 选 Fine-grained，设置权限和过期时间（可设数天/数月）
3. 生成后手动复制 token

本仓库的 `git-temp-token.ts` 提供了「粘贴 token → 输出格式化配置信息」的辅助（双击 exe、自动进剪贴板），但**它原先依赖的自动创建 API 不存在**，现在只能作为格式化工具使用。
该文件已移入 `_archive/`（见第十一节）。

**方案 C：GitHub Actions**

在 CI 里用 `${{ github.token }}` 或 `actions/create-github-app-token`，这是官方对 CI 场景的推荐做法。

---

## 十一、相关文件

```
git-temp-auth/
├── gh-app-token.ts              # 本工具（GitHub App 方案，推荐）
├── README-gh-app.md             # 本文档
├── app-private-key.pem          # App 私钥（极度敏感，已 gitignore）
├── .env                         # 配置（含敏感信息，已 gitignore）
├── package.json                 # 脚本入口（仅保留 gh-app-token 相关）
├── dist/
│   └── gh-app-token.exe         # 编译产物（本工具）
├── dist-app/                    # 可直接双击运行的部署目录（exe + .env + .pem）
└── _archive/                    # 废弃方案归档（仅作技术记录，已 gitignore）
    ├── git-temp-auth.ts         # 旧方案：自动配置本机 git
    ├── git-temp-token.ts        # 旧方案：纯生成器
    ├── git-temp-auth.sh         # 旧方案：Shell 版
    ├── README.md                # 旧方案文档（「母 token 派生子 token」架构不成立）
    ├── README-generator.md      # 旧 generator 文档
    └── git-temp-token.exe       # 旧方案编译产物
```

> ⚠️ 注意：`_archive/` 中的 `git-temp-auth.ts` / `git-temp-token.ts` / `git-temp-auth.sh` 都依赖
> `POST /user/tokens` 这个**不存在的端点**。它们的「自动创建 token」功能无法工作，
> 只有 UI、打包、剪贴板等外围部分是好的。**请使用 `gh-app-token.ts`。**

---

## 十二、重新编译

```bash
bun install
bun run build     # 产出 dist/gh-app-token.exe
bun run typecheck     # 类型检查
```

exe 放到任意目录，把 `.env` 和 `.pem` 一起带过去，双击即可运行。

---
