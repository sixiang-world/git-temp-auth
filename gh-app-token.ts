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

const info = (s: string) => console.log(`${GREEN("[INFO]")}  ${s}`);
const warn = (s: string) => console.log(`${YELLOW("[WARN]")}  ${s}`);
const error = (s: string) => console.error(`${RED("[ERROR]")} ${s}`);
const label = (s: string) => console.log(CYAN(s));

function section(t: string) {
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
  if (cfg.repos.length) body.repositories = cfg.repos;
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

用 GitHub App 私钥换取 1 小时有效的安装访问令牌，输出零残留的 git 命令。
本程序不修改你本机的任何 git 配置。

用法:
  gh-app-token.exe [选项]

选项:
  --json            以 JSON 输出
  --no-clipboard    不写剪贴板
  --check           仅校验配置（私钥、App 信息），不申请令牌
  --help            显示帮助

配置文件:
  ${ENV_FILE}
  需要 APP_ID / INSTALLATION_ID / APP_PRIVATE_KEY_PATH

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
    section("配置校验");
    console.log(`  App ID          : ${cfg.appId}`);
    console.log(`  Installation ID : ${cfg.installationId}`);
    console.log(`  私钥            : ${cfg.privateKeyPath}`);
    console.log(`  App slug        : ${cfg.appSlug || "(未设置，将跳过 bot 身份)"}`);
    console.log(`  限定仓库        : ${cfg.repos.length ? cfg.repos.join(", ") : "(安装范围内全部)"}`);
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

  const text = buildOutput({
    token: iat.token,
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
          authorization_header: `Basic ${Buffer.from(`x-access-token:${iat.token}`, "utf8").toString("base64")}`,
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
        },
        null,
        2,
      ),
    );
    return;
  }

  const copied = flags.noClipboard ? false : copyToClipboard(text);

  section("签发成功");
  console.log(`  令牌前缀      : ${iat.token.slice(0, 12)}...`);
  console.log(`  过期时间(UTC) : ${iat.expiresAt}`);
  console.log(`  过期时间(本地): ${formatLocal(iat.expiresAt)}`);
  console.log(`  有效时长      : 1 小时（GitHub 强制）`);
  console.log(`  仓库范围      : ${iat.repositorySelection === "all" ? "安装范围内全部" : (cfg.repos.join(", ") || "指定仓库")}`);
  if (cfg.appSlug && botId) {
    console.log(`  Bot 身份      : ${cfg.appSlug}[bot]`);
  }
  console.log("");
  if (copied) info("完整配置已复制到剪贴板");
  else warn("剪贴板写入失败，请手动复制下方内容");

  section("配置信息（可直接复制）");
  console.log(text);
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
