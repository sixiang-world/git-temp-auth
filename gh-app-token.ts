#!/usr/bin/env bun
// =============================================================================
// gh-app-token — 基于 GitHub App 的短期凭证签发工具
//
// 原理（已逐条实测验证）：
//   1. 用 GitHub App 的 RSA 私钥本地签一个 RS256 JWT（有效期 10 分钟）
//   2. POST /app/installations/{id}/access_tokens 换取安装访问令牌(IAT, ghs_ 前缀)
//   3. IAT 强制 1 小时有效（GitHub 硬性规定，不可配置）
//   4. 输出零残留的 git 命令（用 git -c 注入，不落盘）
//
// 为什么不是"用 token 创建 PAT"：
//   GitHub 没有提供创建 PAT 的任何 API。实测 POST /user/tokens 返回 404，
//   该端点也不在官方 OpenAPI 规范中。GitHub 官方唯一支持的机器身份方案是 GitHub App。
//
// ⚠️ 重要（2026 实测）：GitHub 自 2026-04 起对新签发的安装令牌推行「stateless」格式，
//   形态为 ghs_<appid>_<JWT>（长约 380~520 字符，含两个点），内部用 ES256 签名。
//   这种令牌**只接受 HTTP Basic 认证**（用户名 x-access-token），
//   **不接受 `Authorization: Bearer <token>`**：
//
//     git -c http.extraHeader="Authorization: Bearer <tok>"  → 401 / 提示输入用户名
//     git -c http.extraHeader="Authorization: Basic <b64>"   → 200 且零残留
//
//   因此本工具输出的是预先 base64 好的 Basic 头值。
//   参考：https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/
//
// ── 网络命令（TextDB 文本托管）────────────────────────────────────────────────
//   除本地输出外，还会把凭证打包 POST 到 TextDB（默认 https://text.hunluan.space/）
//   换取一个公开可读的短地址，于是「配置」就变成一条可以直接扔给任何机器的
//   网络命令：
//
//     curl -s <URL> | bash
//
//   TextDB 接口（已实测，见 https://text.hunluan.space/openapi.json）：
//     POST /update/   body: {key, value, password?}  -> {status:1, data:{key,url}}
//     GET  /{key}                                      -> text/plain 原文
//     DELETE /{key}
//   Key 规则：仅 [0-9a-zA-Z_]，1~512 字符；Value 上限 5 MiB。
//   读取无需密码，所以「读取本身」就是分发渠道；password 只防别人覆盖/删除。
//
//   默认剪贴板内容 = 网络命令（可直接粘贴执行），本地完整配置仍会打印在控制台。
//
// 依赖：bun（无需其他包）
// 配置：同级 .env
// =============================================================================

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createSign, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute, resolve } from "node:path";

const IS_COMPILED = process.argv[0] === "bun";
const APP_DIR = (() => {
  if (IS_COMPILED) return dirname(process.execPath);
  const s = process.argv[1];
  if (s && existsSync(s)) return dirname(s);
  return process.cwd();
})();

const ENV_FILE = join(APP_DIR, ".env");
const GITHUB_API =
  process.env.GITHUB_API_BASE?.replace(/\/$/, "") || "https://api.github.com";
const API_VERSION = "2022-11-28";
const IS_WINDOWS = process.platform === "win32";

// ── 颜色 ─────────────────────────────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const paint = (c: string, s: string) => (useColor ? `\u001b[${c}m${s}\u001b[0m` : s);
const RED = (s: string) => paint("0;31", s);
const GREEN = (s: string) => paint("0;32", s);
const YELLOW = (s: string) => paint("1;33", s);
const CYAN = (s: string) => paint("0;36", s);
const DIM = (s: string) => paint("2", s);

// --json 模式下 stdout 必须是纯 JSON（会被 jq / JSON.parse 消费），
// 因此所有进度与提示信息一律改走 stderr。
const JSON_MODE = process.argv.includes("--json");
const note = (s: string) => (JSON_MODE ? console.error(s) : console.log(s));

const info = (s: string) => note(`${GREEN("[INFO]")}  ${s}`);
const warn = (s: string) => note(`${YELLOW("[WARN]")}  ${s}`);
const error = (s: string) => console.error(`${RED("[ERROR]")} ${s}`);
const label = (s: string) => note(CYAN(s));

function section(t: string) {
  if (JSON_MODE) return;
  console.log("");
  console.log(DIM("─".repeat(60)));
  label(`  ${t}`);
  console.log(DIM("─".repeat(60)));
}

// ── .env ─────────────────────────────────────────────────────────────────────
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

interface Config {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  appSlug: string;
  repos: string[];
  permissions: Record<string, string> | null;
}

/**
 * GitHub 的「创建安装令牌」接口里 `repositories` 只接受**裸仓库名**
 * （如 `my-repo`），不接受 `owner/my-repo`。实测：
 *   {"repositories":["textdb-edgeone"]}            -> 201 ✅
 *   {"repositories":["sixiang-world/textdb-edgeone"]} -> 422 ❌
 *     "There is at least one repository that does not exist or is not
 *      accessible to the parent installation."
 * 但 `owner/repo` 形式对人类更直观（也用于拼 clone URL），
 * 所以这里统一归一化：请求体用裸名，展示和拼 URL 用完整名。
 */
function splitRepo(full: string): { owner: string; name: string; full: string } {
  const i = full.indexOf("/");
  if (i < 0) return { owner: "", name: full, full };
  return { owner: full.slice(0, i), name: full.slice(i + 1), full };
}

/**
 * TextDB 文本托管服务配置。
 *
 * 设计意图：把 1 小时有效的凭证变成「一条网络命令」。
 * 任何机器（CI、远程服务器、别人的电脑）只要能访问这个地址，就能拿到凭证，
 * 不需要传输 .env / .pem，也不需要手动复制粘贴一大段配置。
 */
interface NetConfig {
  /** 服务根地址，如 https://text.hunluan.space */
  baseUrl: string;
  /** 写入用的 key（留空则按时间戳自动生成） */
  key: string;
  /** 可选密码：读取不需要，仅防止别人覆盖/删除这条记录 */
  password: string;
  /** 是否启用网络发布 */
  enabled: boolean;
}

function loadConfig(): Config {
  const e = parseEnvFile(ENV_FILE);
  const g = (k: string) => process.env[k] || e[k] || "";

  const privateKeyPath = g("APP_PRIVATE_KEY_PATH");
  return {
    appId: g("APP_ID"),
    installationId: g("INSTALLATION_ID"),
    privateKeyPath: privateKeyPath
      ? isAbsolute(privateKeyPath)
        ? privateKeyPath
        : join(APP_DIR, privateKeyPath)
      : "",
    appSlug: g("APP_SLUG"),
    repos: (g("TARGET_REPOS") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    permissions: null,
  };
}

const DEFAULT_NET_BASE = "https://text.hunluan.space";

function loadNetConfig(): NetConfig {
  const e = parseEnvFile(ENV_FILE);
  const g = (k: string) => process.env[k] || e[k] || "";
  const enabledRaw = (g("NET_ENABLED") || "1").trim().toLowerCase();
  return {
    baseUrl: (g("NET_BASE_URL") || DEFAULT_NET_BASE).replace(/\/+$/, ""),
    key: g("NET_KEY").trim(),
    password: g("NET_PASSWORD").trim(),
    enabled: !["0", "false", "no", "off"].includes(enabledRaw),
  };
}

function createEnvTemplate() {
  const tpl = [
    "# ============================================================",
    "# gh-app-token 配置（GitHub App 方式）",
    "#",
    "# 为什么用 GitHub App：GitHub 没有提供创建 PAT 的 API。",
    "# 官方唯一支持的机器身份方案就是 GitHub App。",
    "#",
    "# 获取步骤：",
    "#   1. GitHub -> Settings -> Developer settings -> GitHub Apps",
    "#      -> New GitHub App",
    "#   2. 取消勾选 Webhook（不需要回调）",
    "#   3. Repository permissions:",
    "#        Contents        -> Read and write",
    "#        Metadata        -> Read-only（必选，自动带上）",
    "#   4. 点 Create GitHub App",
    "#   5. 记录 App ID（页面顶部）",
    "#   6. 页面下方 Generate a private key，下载 .pem 文件",
    "#      把 .pem 放到本程序同目录，文件名填到下面 APP_PRIVATE_KEY_PATH",
    "#   7. 左侧 Install App，安装到目标仓库",
    "#   8. 安装后看浏览器地址栏 .../installations/12345678",
    "#      末尾数字就是 INSTALLATION_ID",
    "# ============================================================",
    "",
    "APP_ID=",
    "INSTALLATION_ID=",
    "APP_PRIVATE_KEY_PATH=app-private-key.pem",
    "",
    "# App 的 slug（用于生成 bot 提交身份），如 my-token-tool",
    "APP_SLUG=",
    "",
    "# 可选：限制 token 只能访问这些仓库（逗号分隔，留空=安装范围内全部）",
    "TARGET_REPOS=",
    "",
    "# ============================================================",
    "# 网络命令（把凭证发布到文本托管服务，换一条可粘贴的网络命令）",
    "#",
    "# 发布后你会得到形如 https://text.hunluan.space/<key> 的地址，",
    "# 任何机器执行  curl -s <地址> | bash  即可直接拿到凭证。",
    "#",
    "# 安全性说明：该地址是「公开可读」的（读取无需密码），",
    "# 但凭证本身 1 小时后由 GitHub 自动失效，风险窗口很小。",
    "# 若要防止别人覆盖/删除这条记录，可设置 NET_PASSWORD。",
    "# ============================================================",
    "",
    "# 是否启用网络发布（1=启用，0=只用本地输出）",
    "NET_ENABLED=1",
    "",
    "# 服务地址（默认 text.hunluan.space，自己的服务可改）",
    "NET_BASE_URL=https://text.hunluan.space",
    "",
    "# 写入用的 key，仅允许字母/数字/下划线；留空则按时间戳自动生成",
    "NET_KEY=",
    "",
    "# 可选：保护密码（读取不需要密码，仅防止别人覆盖/删除）",
    "NET_PASSWORD=",
    "",
  ].join("\r\n");
  writeFileSync(ENV_FILE, tpl, "utf8");
}

// ── JWT 签名（RS256，零依赖） ────────────────────────────────────────────────
function b64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

/**
 * 生成 GitHub App 用的 JWT。
 *
 * 要点：
 *   - iat 提前 60 秒，防时钟漂移（GitHub 要求 iat 不能是未来时间）
 *   - exp 最长为 10 分钟，GitHub 硬性限制
 *   - 签名用 RS256（RSA-SHA256）+ PKCS#8 或 PKCS#1 私钥均可
 */
function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/** 本地自检：确保私钥能签、且能被对应公钥验签 */
function selfCheckKey(privateKeyPem: string): boolean {
  try {
    const { createVerify } = require("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const si = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iat: now, exp: now + 60, iss: "0" }),
    )}`;
    const sig = createSign("RSA-SHA256").update(si).sign(privateKeyPem);
    const pub = createPublicKey(privateKeyPem);
    return createVerify("RSA-SHA256").update(si).verify(pub, sig);
  } catch {
    return false;
  }
}

// ── GitHub API ───────────────────────────────────────────────────────────────
interface Iat {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection: string;
}

async function fetchInstallationToken(
  cfg: Config,
  jwt: string,
): Promise<Iat> {
  const body: Record<string, unknown> = {};
  // ⚠️ 必须去掉 owner 前缀，只传裸仓库名，否则 422（见 splitRepo 注释）
  if (cfg.repos.length) body.repositories = cfg.repos.map((r) => splitRepo(r).name);
  if (cfg.permissions) body.permissions = cfg.permissions;

  info(`正在向 GitHub 申请安装访问令牌（Installation ${cfg.installationId}）...`);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${cfg.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "gh-app-token",
        "Content-Type": "application/json",
      },
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    },
  );

  const raw = await res.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    error(`申请令牌失败 (HTTP ${res.status})`);
    console.error(data ? JSON.stringify(data, null, 2) : raw);
    const msg = String(data?.message ?? "").toLowerCase();

    if (msg.includes("could not be decoded")) {
      warn("JWT 无法被 GitHub 验证。请检查：");
      warn("  1. APP_ID 是否正确（必须是数字 App ID，不是 Client ID）");
      warn("     —— 注意：如果 App ID 不存在，GitHub 也会报这个错");
      warn("  2. 私钥是否与这个 App 匹配");
      warn("  3. 本机时间是否准确（偏差过大会导致 JWT 失效）");
    } else if (res.status === 404) {
      warn("Installation 不存在。请检查 INSTALLATION_ID 是否正确，");
      warn("以及这个 App 是否真的安装到了目标账号/仓库上。");
    } else if (res.status === 422 || msg.includes("not accessible")) {
      warn("TARGET_REPOS 里有仓库不在这个 App 的安装范围内。");
      warn("请到 GitHub App 设置页把它加入安装范围，或把该仓库从 TARGET_REPOS 移除。");
      warn("（本工具已自动去掉 owner/ 前缀；若你填的是 owner/repo，这不是原因）");
    } else if (msg.includes("expired")) {
      warn("JWT 已过期，请检查本机系统时间");
    }
    process.exit(1);
  }

  return {
    token: data.token,
    expiresAt: data.expires_at,
    permissions: data.permissions ?? {},
    repositorySelection: data.repository_selection ?? "all",
  };
}

/** 查 bot 用户 ID（用于生成 bot 提交身份） */
async function fetchBotId(slug: string): Promise<string | null> {
  if (!slug) return null;
  try {
    const res = await fetch(
      `${GITHUB_API}/users/${encodeURIComponent(`${slug}[bot]`)}`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "gh-app-token" } },
    );
    if (!res.ok) return null;
    const d: any = await res.json();
    return d?.id ? String(d.id) : null;
  } catch {
    return null;
  }
}

// ── 剪贴板 ───────────────────────────────────────────────────────────────────
function copyToClipboard(text: string): boolean {
  if (IS_WINDOWS) {
    const tmp = join(
      process.env.TEMP || process.env.TMP || APP_DIR,
      `gat-clip-${process.pid}-${Date.now()}.txt`,
    );
    try {
      writeFileSync(tmp, text, "utf8");
      const safe = tmp.replace(/'/g, "''");
      const script =
        `$ErrorActionPreference='Stop';` +
        `$c=[System.IO.File]::ReadAllText('${safe}', [System.Text.Encoding]::UTF8);` +
        `Set-Clipboard -Value $c`;
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
      );
      if (!r.error && r.status === 0) return true;
    } catch {
      /* fallthrough */
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      const r = spawnSync("clip", [], {
        input: text,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      return !r.error && r.status === 0;
    } catch {
      return false;
    }
  }
  const cands: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [c, a] of cands) {
    const r = spawnSync(c, a, { input: text, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

// ── 输出构造 ─────────────────────────────────────────────────────────────────
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildOutput(args: {
  token: string;
  expiresAt: string;
  appSlug: string;
  botId: string | null;
  repos: string[];
}): string {
  const { token, expiresAt, appSlug, botId, repos } = args;
  const repoArg = repos.length ? `${repos.join(" ")}` : "<owner>/<repo>";

  const botName = appSlug ? `${appSlug}[bot]` : "";
  const botEmail =
    appSlug && botId
      ? `${botId}+${appSlug}[bot]@users.noreply.github.com`
      : "";

  // 关键：GitHub 新格式的 stateless 安装令牌（ghs_<appid>_<JWT>）**不认 Authorization 头**，
  // 只接受 HTTP Basic 认证（用户名 x-access-token + 密码 = 令牌）。实测：
  //   http.extraHeader="Authorization: Bearer <tok>"  -> 401 / 提示输入用户名
  //   http.extraHeader="Authorization: Basic <b64>"   -> 200 且零残留
  // 因此这里把 "x-access-token:<token>" 预先 base64 编码，仍然只注入请求头，不落盘。
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");

  const firstRepo = repos.length ? repos[0] : "<owner>/<repo>";
  const idArgs = botName
    ? ` -c user.name="${botName}" -c user.email="${botEmail}"`
    : "";
  // ⚠️ -c 必须写在子命令（clone/pull/push）**之前**！
  //   git -c k=v clone ...   -> 仅本次命令生效，不落盘 ✅
  //   git clone -c k=v ...   -> 会被 git 当作 clone 的选项，写进新仓库 .git/config ❌ 令牌落盘
  //   实测确认：后者会在 .git/config 里留下 [http] extraheader = Authorization: Basic <明文令牌>
  const gitC = (cmd: string) =>
    `git -c http.extraHeader="Authorization: Basic $GH_TEMP_TOKEN"${idArgs} ${cmd}`;

  const L: string[] = [];
  L.push("# ====== GitHub App 短期访问凭证 ======");
  L.push(`# 过期时间(UTC) : ${expiresAt}`);
  L.push(`# 过期时间(本地): ${formatLocal(expiresAt)}`);
  L.push(`# 有效期        : 1 小时（GitHub 强制，不可配置）`);
  L.push("");
  L.push("# --- 原始 Token（ghs_ 开头，1 小时后自动失效）---");
  L.push(token);
  L.push("");
  L.push("# --- Authorization 头（已 base64，粘贴即用）-----------------");
  L.push("# 注意：不要用 Authorization: Bearer <token>");
  L.push("#       新版 ghs_ 令牌只认 Basic 认证，Bearer 会被拒（401）");
  L.push(`Authorization: Basic ${basic}`);
  L.push("");
  L.push("# --- 用法：零残留（推荐）-------------------------------------");
  L.push("# 用 git -c 临时注入请求头，不写任何配置、不改凭证、不留 .git/config");
  L.push("#");
  L.push("# ⚠️ -c 必须写在 clone/pull/push 之前！");
  L.push("#     git -c http.extraHeader=... clone  -> 仅本次生效，不落盘  ✅");
  L.push("#     git clone -c http.extraHeader=...  -> 令牌被写进 .git/config ❌");
  L.push("");
  L.push("# PowerShell:");
  L.push(`$env:GH_TEMP_TOKEN = "${basic}"`);
  L.push(gitC(`clone https://github.com/${firstRepo}.git`));
  L.push("");
  L.push("# Bash / Git Bash:");
  L.push(`export GH_TEMP_TOKEN="${basic}"`);
  L.push(gitC(`clone https://github.com/${firstRepo}.git`));
  L.push("");
  L.push("# --- 常用操作模板 -------------------------------------------");
  L.push("# 在已有仓库里，用同样方式执行任意 git 命令（-c 同样放在子命令前）：");
  L.push(`#   ${gitC("pull")}`);
  L.push(`#   ${gitC("push")}`);
  L.push(`# 若在仓库目录内执行，可加 -C 指定目录：`);
  L.push(`#   git -C /path/to/repo ${gitC("status")}`);
  L.push("");
  L.push("# --- 备选：URL 内嵌（简单但会落盘，慎用）---------------------");
  L.push("# 这种方式 git 会把带令牌的 URL 明文写进 .git/config，");
  L.push("# 项目被分享/打包时令牌即泄露。仅在临时容器里图省事时使用。");
  L.push("# 用户名必须是 x-access-token，密码位置放原始令牌（不是 base64）：");
  L.push(`#   git clone https://x-access-token:${token.slice(0, 18)}...@github.com/${firstRepo}.git`);
  if (botName) {
    L.push("");
    L.push("# --- 提交身份（可选）----------------------------------------");
    L.push(`# 若希望提交显示为 App 机器人而非你本人：`);
    L.push(`#   name  = ${botName}`);
    L.push(`#   email = ${botEmail}`);
  }
  L.push("");
  L.push("# --- 清理 --------------------------------------------------");
  L.push("# 本地变量用完即弃，无需清理。若想主动清除：");
  L.push("#   PowerShell:  Remove-Item Env:\\GH_TEMP_TOKEN");
  L.push("#   Bash:        unset GH_TEMP_TOKEN");
  return L.join("\n");
}

// ── 网络命令：把凭证发布到文本托管，换一条可直接粘贴的命令 ───────────────────
/**
 * 生成随机 key。规则来自服务端：仅允许 [0-9a-zA-Z_]，长度 1~512。
 * 前缀固定的好处：一眼能认出这是本工具发布的临时凭证，方便事后批量清理。
 */
function makeNetKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `ghtoken_${stamp}_${rand}`;
}

interface NetPublishResult {
  ok: boolean;
  url: string;
  key: string;
  error?: string;
}

/**
 * 把一段 shell 脚本发布到 TextDB，返回可公开读取的 URL。
 *
 * 接口（已实测）：
 *   POST {base}/update/   {"key":..,"value":..,"password":..}
 *     -> {"status":1,"data":{"key":"..","url":".."}}
 * 注意：返回的 url 由服务端给出，优先采用；只有拿不到时才本地拼。
 */
async function publishToNet(
  net: NetConfig,
  value: string,
): Promise<NetPublishResult> {
  const key = net.key || makeNetKey();
  const endpoint = `${net.baseUrl}/update/`;

  const body: Record<string, string> = { key, value };
  if (net.password) body.password = net.password;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "gh-app-token",
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* 非 JSON 响应，下面按失败处理并回显原文 */
    }

    if (!res.ok || !data || data.status !== 1) {
      return {
        ok: false,
        key,
        url: "",
        error: data?.error || `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      };
    }

    return {
      ok: true,
      key: data?.data?.key || key,
      url: data?.data?.url || `${net.baseUrl}/${key}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      key,
      url: "",
      error: e?.message ?? String(e),
    };
  }
}

/**
 * 生成「网络命令」要发布的 shell 脚本。
 *
 * 这个脚本会被  curl -s <url> | bash  直接执行，所以必须自包含：
 *   1. 把 base64 的 Basic 凭证导出成环境变量
 *   2. 立刻用 ls-remote 验证凭证有效（失败就早退，不让后续命令默默 401）
 *   3. 打印携带 -c 的 git 命令模板，用户复制即可用
 *
 * 刻意不在这里自动 clone/push —— 脚本只做「装填子弹」，
 * 具体对哪个仓库做什么操作，交给人或 Agent 决定。
 */
function buildNetScript(args: {
  basic: string;
  rawToken: string;
  expiresAt: string;
  appSlug: string;
  botId: string | null;
  repos: string[];
}): string {
  const { basic, rawToken, expiresAt, appSlug, botId, repos } = args;
  const firstRepo = repos.length ? repos[0] : "<owner>/<repo>";
  const botName = appSlug ? `${appSlug}[bot]` : "";
  const botEmail =
    appSlug && botId
      ? `${botId}+${appSlug}[bot]@users.noreply.github.com`
      : "";

  const idArgs = botName
    ? ` -c user.name="${botName}" -c user.email="${botEmail}"`
    : "";

  const L: string[] = [];
  L.push("#!/usr/bin/env bash");
  L.push("# ============================================================");
  L.push("# GitHub App 短期访问凭证 —— 网络命令");
  L.push("#");
  L.push("# 本脚本由 gh-app-token 自动生成并托管，可直接执行：");
  L.push("#   curl -s <本文件地址> | bash");
  L.push("#");
  L.push("# 执行后效果：");
  L.push("#   1. 校验凭证是否仍然有效（过期会立刻提示）");
  L.push("#   2. 打印可直接使用的 git 命令模板");
  L.push("#");
  L.push(`# 过期时间(UTC) : ${expiresAt}`);
  L.push(`# 过期时间(本地): ${formatLocal(expiresAt)}`);
  L.push("# 有效期        : 1 小时（GitHub 强制，不可配置）");
  L.push("# ============================================================");
  L.push("");
  L.push("set -u");
  L.push("");
  L.push("# ── 1. 装填凭证 ──────────────────────────────────────────");
  L.push("# 这里的值是 base64( x-access-token:<原始令牌> )，可直接塞进 Basic 头。");
  L.push("# ⚠️ 新版 ghs_ 令牌只认 Basic 认证，用 Bearer 会被拒（401）。");
  L.push(`export GH_TEMP_TOKEN="${basic}"`);
  L.push("");

  if (botName) {
    L.push("# bot 提交身份（可选）");
    L.push(`export GH_BOT_NAME="${botName}"`);
    L.push(`export GH_BOT_EMAIL="${botEmail}"`);
    L.push("");
  }

  L.push("# ── 2. 校验凭证 ──────────────────────────────────────────");
  L.push(`_REPO="${firstRepo}"`);
  L.push('if [ "$_REPO" = "<owner>/<repo>" ]; then');
  L.push('  echo "⚠️  未在配置里指定仓库，跳过连通性校验。"');
  L.push("else");
  L.push('  echo "正在校验凭证..."');
  L.push("  _ERR=$(git -c http.extraHeader=\"Authorization: Basic $GH_TEMP_TOKEN\" \\");
  L.push(`      ls-remote "https://github.com/$_REPO.git" HEAD 2>&1 >/dev/null)`);
  L.push("  if [ $? -eq 0 ]; then");
  L.push('    echo "✅ 凭证有效，可用仓库: $_REPO"');
  L.push("  else");
  L.push("    # 区分「凭证过期」和「网络不通」——两者的处理方式完全不同，");
  L.push("    # 报错信息必须让人一眼看出该重新生成还是该查网络。");
  L.push('    case "$_ERR" in');
  L.push("      *\"could not read Username\"*|*\"Authentication failed\"*|*401*)");
  L.push('        echo "❌ 凭证无效或已过期。请重新运行 gh-app-token 生成。"');
  L.push("        exit 1 ;;");
  L.push("      *)");
  L.push('        echo "⚠️  无法连接 GitHub，跳过校验（这不代表凭证有问题）。"');
  L.push('        echo "    网络错误: $(echo "$_ERR" | head -1)"');
  L.push('        echo "    凭证是否有效以实际 git 命令结果为准。" ;;');
  L.push("    esac");
  L.push("  fi");
  L.push("fi");
  L.push("");
  L.push("# ── 3. 可用命令 ──────────────────────────────────────────");
  L.push("# 关键：-c 必须写在 clone/pull/push 之前！");
  L.push('#   git -c http.extraHeader=... clone  -> 仅本次生效，不落盘  ✅');
  L.push('#   git clone -c http.extraHeader=...   -> 令牌被写进 .git/config ❌');
  L.push('_GIT="git -c http.extraHeader=Authorization: Basic $GH_TEMP_TOKEN' + idArgs + '"');
  L.push("");
  L.push('echo ""');
  L.push('echo "可用命令："');
  L.push(`echo "  $_GIT clone https://github.com/${firstRepo}.git"`);
  L.push('echo "  $_GIT pull"');
  L.push('echo "  $_GIT push"');
  L.push("");
  L.push("# 直接执行任意 git 命令也可以，例如：");
  L.push(`#   git -c http.extraHeader="Authorization: Basic $GH_TEMP_TOKEN"${idArgs} clone https://github.com/${firstRepo}.git`);
  L.push("");
  L.push("# 原始令牌（需要走 REST API 时用，注意别打印到日志）：");
  L.push(`#   ${rawToken.slice(0, 24)}...（完整值见本地配置）`);
  L.push("");
  L.push("# 清理（可选）：");
  L.push("#   unset GH_TEMP_TOKEN");
  return L.join("\n");
}

/**
 * 生成给 AI Agent 的提示词。
 *
 * 目标是让 Agent 读完就能自己完成「取凭证 → 用凭证」的全过程，
 * 不需要人去解释 Basic/Bearer 的区别或 -c 的位置坑。
 * 刻意保持简短 —— 越短的提示词，Agent 越不容易漏读关键约束。
 */
function buildAgentPrompt(args: {
  netUrl: string;
  expiresAt: string;
  appSlug: string;
  botId: string | null;
  repos: string[];
}): string {
  const { netUrl, expiresAt, appSlug, botId, repos } = args;
  const firstRepo = repos.length ? repos[0] : "<owner>/<repo>";
  const repoScope = repos.length ? repos.join(", ") : "安装范围内全部仓库";
  const botName = appSlug ? `${appSlug}[bot]` : "";
  const botEmail = appSlug && botId ? `${botId}+${appSlug}[bot]@users.noreply.github.com` : "";

  const L: string[] = [];
  L.push("你是执行 GitHub 操作的助手。默认全程用网络命令，先取凭证再执行 git 操作。");
  L.push("");
  L.push(`1. 取凭证：export GH_TEMP_TOKEN=$(curl -s ${netUrl} | grep -oP '(?<=GH_TEMP_TOKEN=")[^"]+')`);
  L.push("   curl 失败则向用户索要凭证内容（GH_TEMP_TOKEN 是已 base64 的 Basic 认证值）。");
  L.push("");
  L.push("2. 硬约束（违反必失败）：");
  L.push('   - 只用 Basic：git -c http.extraHeader="Authorization: Basic $GH_TEMP_TOKEN" <git 子命令>');
  L.push("   - -c 必须写在子命令（clone/pull/push）之前，放后面令牌会落盘 .git/config");
  L.push("   - 不改全局 git 配置、不用 https://x-access-token:TOKEN@ 内嵌 URL、不打印或提交令牌");
  L.push("");
  L.push(`3. 范围与寿命：仅限仓库 ${repoScope}；有效期 1 小时，本次到期 ${expiresAt}（本地 ${formatLocal(expiresAt)}）。`);
  L.push("   401 即过期，让用户重新运行 gh-app-token 生成，不要重试。");
  L.push("");
  L.push(`4. 示例：git -c http.extraHeader="Authorization: Basic $GH_TEMP_TOKEN" clone https://github.com/${firstRepo}.git`);
  if (botName) {
    L.push(`   提交身份（可选）：-c user.name="${botName}" -c user.email="${botEmail}"`);
  }
  L.push("");
  L.push("完成后 unset GH_TEMP_TOKEN。");
  return L.join("\n");
}

// ── 等待按键 ─────────────────────────────────────────────────────────────────
function pauseIfNeeded() {
  if (!process.stdout.isTTY || !process.stdin.isTTY || process.env.GTT_NO_PAUSE) return;
  console.log("");
  console.log(DIM("按 Enter 键退出..."));
  try {
    const buf = Buffer.alloc(1);
    const { readSync } = require("node:fs");
    while (true) {
      let n = 0;
      try {
        n = readSync(0, buf, 0, 1, null);
      } catch {
        break;
      }
      if (n <= 0) break;
      const c = buf[0];
      if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x1b) break;
    }
  } catch {
    /* ignore */
  }
}

function printHelp() {
  console.log(`
${CYAN("gh-app-token")} — GitHub App 短期凭证签发工具

用 GitHub App 私钥换取 1 小时有效的安装访问令牌。
输出四块内容：配置信息 / 网络命令地址 / 可复制命令 / Agent 提示词。
本程序不修改你本机的任何 git 配置。

用法:
  gh-app-token.exe [选项]

选项:
  --json            以 JSON 输出
  --no-clipboard    不写剪贴板
  --no-net          不发布到网络（只用本地输出）
  --check           仅校验配置（私钥、App 信息、网络设置），不申请令牌
  --help            显示帮助

配置文件:
  ${ENV_FILE}
  必需: APP_ID / INSTALLATION_ID / APP_PRIVATE_KEY_PATH
  可选: APP_SLUG / TARGET_REPOS / NET_* （见下方）

网络命令:
  默认会把凭证发布到文本托管服务，换一条可直接粘贴的命令：

      curl -s <地址> | bash

  文本托管服务地址（默认 ${DEFAULT_NET_BASE}）：
    ${DEFAULT_NET_BASE}    自建服务，匿名读写

  相关配置项:
    NET_ENABLED     1=启用（默认），0=只用本地
    NET_BASE_URL    服务地址
    NET_KEY         写入用的 key，留空自动生成
    NET_PASSWORD    可选，仅防别人覆盖/删除（读取不需要密码）

为什么是 GitHub App:
  GitHub 未提供创建 PAT 的 API（POST /user/tokens 实测 404）。
  GitHub App 是官方唯一支持的机器身份方案。
`);
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const argv = process.argv.slice(2);
  const flags = {
    json: argv.includes("--json"),
    noClipboard: argv.includes("--no-clipboard"),
    noNet: argv.includes("--no-net"),
    check: argv.includes("--check"),
    help: argv.includes("--help") || argv.includes("-h"),
  };

  if (flags.help) {
    printHelp();
    pauseIfNeeded();
    return;
  }

  if (!existsSync(ENV_FILE)) {
    createEnvTemplate();
    section("首次使用");
    warn("未找到配置文件，已生成模板：");
    console.log(`  ${ENV_FILE}`);
    console.log("");
    console.log("请按文件内注释完成 GitHub App 配置后重新运行。");
    console.log("");
    console.log(DIM("核心步骤：建 App → 下载 .pem → 安装到仓库 → 填 App ID 和 Installation ID"));
    pauseIfNeeded();
    return;
  }

  const cfg = loadConfig();

  const missing = [
    !cfg.appId && "APP_ID",
    !cfg.installationId && "INSTALLATION_ID",
    !cfg.privateKeyPath && "APP_PRIVATE_KEY_PATH",
  ].filter(Boolean) as string[];

  if (missing.length) {
    section("配置不完整");
    error(`缺少: ${missing.join(", ")}`);
    console.log(`  请编辑: ${ENV_FILE}`);
    pauseIfNeeded();
    process.exit(1);
  }

  if (!existsSync(cfg.privateKeyPath)) {
    section("私钥文件不存在");
    error(`找不到: ${cfg.privateKeyPath}`);
    console.log("请把从 GitHub App 页面下载的 .pem 文件放到该路径。");
    pauseIfNeeded();
    process.exit(1);
  }

  // 读取私钥（兼容 PKCS#1 与 PKCS#8）
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(cfg.privateKeyPath, "utf8");
  } catch (e: any) {
    section("私钥读取失败");
    error(e?.message ?? String(e));
    pauseIfNeeded();
    process.exit(1);
  }

  // 本地自检
  if (!selfCheckKey(privateKeyPem)) {
    section("私钥无效");
    error("无法用该私钥完成 RSA 签名自检");
    console.log("请确认文件是 GitHub App 下载的 PEM 私钥（BEGIN RSA PRIVATE KEY / BEGIN PRIVATE KEY）");
    pauseIfNeeded();
    process.exit(1);
  }
  info("私钥自检通过 ✓");

  if (flags.check) {
    const netCfg = loadNetConfig();
    section("配置校验");
    console.log(`  App ID          : ${cfg.appId}`);
    console.log(`  Installation ID : ${cfg.installationId}`);
    console.log(`  私钥            : ${cfg.privateKeyPath}`);
    console.log(`  App slug        : ${cfg.appSlug || "(未设置，将跳过 bot 身份)"}`);
    console.log(`  限定仓库        : ${cfg.repos.length ? cfg.repos.join(", ") : "(安装范围内全部)"}`);
    console.log(`  网络发布        : ${netCfg.enabled ? netCfg.baseUrl : "(已禁用)"}`);
    if (netCfg.enabled) {
      console.log(`  发布 key        : ${netCfg.key || "(自动生成)"}`);
      console.log(`  记录密码        : ${netCfg.password ? "已设置" : "(无，任何人可覆盖该记录)"}`);
    }
    console.log("");
    info("配置看起来正常。去掉 --check 即可正式申请令牌。");
    pauseIfNeeded();
    return;
  }

  // ── 签发 ──────────────────────────────────────────────────────────────────
  const jwt = createAppJwt(cfg.appId, privateKeyPem);
  info("已生成 JWT（RS256，10 分钟有效）");

  const iat = await fetchInstallationToken(cfg, jwt);
  const botId = await fetchBotId(cfg.appSlug);
  if (cfg.appSlug && !botId) {
    warn(`未能查到 bot 用户 "${cfg.appSlug}[bot]"，将跳过提交身份信息`);
  }

  const basic = Buffer.from(`x-access-token:${iat.token}`, "utf8").toString(
    "base64",
  );

  const text = buildOutput({
    token: iat.token,
    expiresAt: iat.expiresAt,
    appSlug: cfg.appSlug,
    botId,
    repos: cfg.repos,
  });

  const net = loadNetConfig();

  // ── 网络发布：把凭证变成一条可粘贴的命令 ──────────────────────────────────
  let netResult: NetPublishResult | null = null;
  if (net.enabled && !flags.noNet) {
    const script = buildNetScript({
      basic,
      rawToken: iat.token,
      expiresAt: iat.expiresAt,
      appSlug: cfg.appSlug,
      botId,
      repos: cfg.repos,
    });
    info(`正在发布到 ${net.baseUrl} ...`);
    netResult = await publishToNet(net, script);
    if (!netResult.ok) {
      warn(`网络发布失败：${netResult.error}`);
      warn("已跳过网络命令，本地配置仍然可用。");
    }
  }

  const netUrl = netResult?.ok ? netResult.url : "";

  const agentPrompt = buildAgentPrompt({
    netUrl: netUrl || "<网络命令地址（发布成功后才有）>",
    expiresAt: iat.expiresAt,
    appSlug: cfg.appSlug,
    botId,
    repos: cfg.repos,
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          token: iat.token,
          // 新版 ghs_ 令牌只认 Basic 认证，这里直接给出可直接用的头值
          authorization_header: `Basic ${basic}`,
          expires_at: iat.expiresAt,
          expires_at_local: formatLocal(iat.expiresAt),
          token_type: "installation_access_token",
          prefix: "ghs_",
          is_stateless: iat.token.split(".").length - 1 >= 2,
          permissions: iat.permissions,
          repository_selection: iat.repositorySelection,
          bot_name: cfg.appSlug ? `${cfg.appSlug}[bot]` : null,
          bot_email:
            cfg.appSlug && botId
              ? `${botId}+${cfg.appSlug}[bot]@users.noreply.github.com`
              : null,
          network: netResult
            ? {
                ok: netResult.ok,
                key: netResult.key,
                url: netResult.url || null,
                // 可直接复制粘贴的一条命令
                command: netResult.ok
                  ? `curl -s ${netResult.url} | bash`
                  : null,
                error: netResult.error ?? null,
              }
            : { enabled: false, reason: flags.noNet ? "--no-net" : "NET_ENABLED=0" },
          agent_prompt: agentPrompt,
        },
        null,
        2,
      ),
    );
    return;
  }

  // 默认复制「网络命令」；发布失败则退回复制本地完整配置
  const clipText = netUrl ? `curl -s ${netUrl} | bash` : text;
  const copied = flags.noClipboard ? false : copyToClipboard(clipText);

  section("签发成功");
  console.log(`  令牌前缀      : ${iat.token.slice(0, 12)}...`);
  console.log(`  过期时间(UTC) : ${iat.expiresAt}`);
  console.log(`  过期时间(本地): ${formatLocal(iat.expiresAt)}`);
  console.log(`  有效时长      : 1 小时（GitHub 强制）`);
  console.log(`  仓库范围      : ${iat.repositorySelection === "all" ? "安装范围内全部" : (cfg.repos.join(", ") || "指定仓库")}`);
  if (cfg.appSlug && botId) {
    console.log(`  Bot 身份      : ${cfg.appSlug}[bot]`);
  }

  // ── 1. 配置信息 ───────────────────────────────────────────────────────────
  section("1. 配置信息");
  console.log(text);

  // ── 2. 网络命令地址 ───────────────────────────────────────────────────────
  section("2. 网络命令地址");
  if (netUrl) {
    console.log(`  ${netUrl}`);
    console.log("");
    console.log(DIM(`  公开可读，${formatLocal(iat.expiresAt)} 前有效`));
    if (net.password) {
      console.log(DIM("  已设保护密码：别人无法覆盖/删除这条记录"));
    } else {
      console.log(DIM("  未设保护密码：任何人可覆盖这条记录（可设 NET_PASSWORD 防护）"));
    }
  } else if (flags.noNet) {
    console.log(DIM("  已跳过（--no-net）"));
  } else if (!net.enabled) {
    console.log(DIM("  已禁用（NET_ENABLED=0）"));
  } else {
    console.log(DIM(`  发布失败${netResult?.error ? `：${netResult.error}` : ""}`));
  }

  // ── 3. 命令复制粘贴 ───────────────────────────────────────────────────────
  section("3. 命令复制粘贴");
  if (netUrl) {
    console.log(CYAN(`curl -s ${netUrl} | bash`));
    console.log("");
    console.log(DIM("  在任何机器上执行这一条即可拿到凭证并校验有效性。"));
    if (copied) {
      console.log("");
      info("该命令已复制到剪贴板");
    } else {
      console.log("");
      warn("剪贴板写入失败，请手动复制上面这条命令");
    }
  } else {
    console.log(DIM("  网络命令不可用，请直接复制上方「配置信息」。"));
    if (copied) console.log("");
    if (!flags.noClipboard) {
      if (copied) info("完整本地配置已复制到剪贴板");
      else warn("剪贴板写入失败，请手动复制上方内容");
    }
  }

  // ── 4. Agent 优化 ─────────────────────────────────────────────────────────
  section("4. Agent 优化（可直接粘贴给 AI）");
  console.log(agentPrompt);
  console.log("");
  console.log(DIM("─".repeat(60)));
  console.log(DIM("  本程序未修改你本机的任何 git 配置"));
  console.log(DIM("  该令牌 1 小时后由 GitHub 自动失效"));
  console.log(DIM("─".repeat(60)));

  pauseIfNeeded();
}

main().catch((e) => {
  error(e?.stack ?? String(e));
  pauseIfNeeded();
  process.exit(1);
});
