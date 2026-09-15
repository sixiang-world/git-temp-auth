#!/usr/bin/env bun
// =============================================================================
// git-temp-auth — 临时 GitHub 身份配置工具（Bun / Windows 版）
//
// 功能：
//   1. 启动即自动读取同目录 .env（Bun 原生能力，无需 dotenv）
//   2. 通过 GitHub API 自动创建短期 fine-grained PAT（1~N 小时过期）
//   3. 自动配置 git 全局 user.name / user.email / credential
//   4. 输出「一键粘贴」配置命令，并可直接写入剪贴板
//   5. 后台守护进程到期自动撤销 token 并清除本地 git 凭证
//
// 依赖：bun 1.x + git
// 兼容：Windows / macOS / Linux（Windows 优先）
//
// 用法：
//   bun git-temp-auth.ts                 创建临时授权（默认 1 小时）
//   bun git-temp-auth.ts --hours 5       创建 5 小时临时授权
//   bun git-temp-auth.ts status          查看状态
//   bun git-temp-auth.ts revoke          提前撤销
//   bun git-temp-auth.ts init            交互式写入 .env
//   bun git-temp-auth.ts help            帮助
// =============================================================================

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  chmodSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ── 路径 ─────────────────────────────────────────────────────────────────────
const SCRIPT_PATH = resolve(process.argv[1] ?? __filename);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const ENV_FILE = join(SCRIPT_DIR, ".env");
const STATE_FILE = join(SCRIPT_DIR, ".state");
const LOG_FILE = join(SCRIPT_DIR, ".expire.log");

// 可通过环境变量覆盖，便于测试或 GitHub Enterprise
const GITHUB_API = process.env.GITHUB_API_BASE?.replace(/\/$/, "") || "https://api.github.com";
const API_VERSION = "2022-11-28";

const IS_WINDOWS = process.platform === "win32";

// ── 颜色（不依赖 chalk） ─────────────────────────────────────────────────────
const useColor = (() => {
  if (process.env.NO_COLOR) return false;
  // Windows Terminal / 现代终端支持 ANSI；PowerShell ISE 等不支持
  if (IS_WINDOWS && process.env.WT_SESSION) return true;
  if (IS_WINDOWS && process.stdout.isTTY) return true;
  return !!process.stdout.isTTY;
})();

const paint = (code: string, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const RED = (s: string) => paint("0;31", s);
const GREEN = (s: string) => paint("0;32", s);
const YELLOW = (s: string) => paint("1;33", s);
const CYAN = (s: string) => paint("0;36", s);
const DIM = (s: string) => paint("2", s);

const info = (s: string) => console.log(`${GREEN("[INFO]")}  ${s}`);
const warn = (s: string) => console.log(`${YELLOW("[WARN]")}  ${s}`);
const error = (s: string) => console.error(`${RED("[ERROR]")} ${s}`);
const label = (s: string) => console.log(CYAN(s));

function die(msg: string): never {
  error(msg);
  process.exit(1);
}

/**
 * 打印标题块。
 * 不使用制表符边框：Windows 终端对 box-drawing 字符宽度处理不一致，容易错位。
 * 改用纯 ASCII 分隔线，任何字体下都对齐。
 */
function box(title: string) {
  const line = "─".repeat(46);
  console.log("");
  label(line);
  label(`  ${title}`);
  label(line);
}

// ── 时间工具 ─────────────────────────────────────────────────────────────────
/** 当前时间 + N 小时，返回 GitHub 要求的 UTC ISO8601 格式 */
function isoPlusHours(hours: number): string {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// ── .env 读取（Bun 已自动加载，这里做兜底解析 + 取值校验） ────────────────────
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    // 去掉包裹的引号
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

interface Config {
  masterToken: string;
  username: string;
  email: string;
}

function loadConfig(): Config {
  // Bun 会自动把同目录 .env 注入 process.env；同时自解析兜底，确保任何启动方式都生效
  const fileEnv = parseEnvFile(ENV_FILE);
  const get = (k: string) => process.env[k] ?? fileEnv[k] ?? "";

  const masterToken = get("GITHUB_MASTER_TOKEN");
  const username = get("GIT_USERNAME");
  const email = get("GIT_EMAIL");

  const missing = [
    !masterToken && "GITHUB_MASTER_TOKEN",
    !username && "GIT_USERNAME",
    !email && "GIT_EMAIL",
  ].filter(Boolean) as string[];

  if (missing.length) {
    error(`配置缺失: ${missing.join(", ")}`);
    console.error(`  请编辑 ${ENV_FILE}`);
    console.error(`  或运行: bun ${SCRIPT_PATH} init`);
    process.exit(1);
  }

  return { masterToken, username, email };
}

// ── 状态文件 ─────────────────────────────────────────────────────────────────
interface State {
  tokenId: string;
  token: string;
  expiresAt: string;
  expireEpoch: number;
  guardPid: number;
  createdAt: string;
  hours: number;
}

function saveState(s: State) {
  writeFileSync(
    STATE_FILE,
    [
      `TOKEN_ID=${s.tokenId}`,
      `TOKEN=${s.token}`,
      `EXPIRES_AT=${s.expiresAt}`,
      `EXPIRE_EPOCH=${s.expireEpoch}`,
      `GUARD_PID=${s.guardPid}`,
      `CREATED_AT=${s.createdAt}`,
      `HOURS=${s.hours}`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
}

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  const env = parseEnvFile(STATE_FILE);
  if (!env.TOKEN_ID) return null;
  return {
    tokenId: env.TOKEN_ID,
    token: env.TOKEN ?? "",
    expiresAt: env.EXPIRES_AT ?? "",
    expireEpoch: Number(env.EXPIRE_EPOCH ?? 0),
    guardPid: Number(env.GUARD_PID ?? 0),
    createdAt: env.CREATED_AT ?? "",
    hours: Number(env.HOURS ?? 0),
  };
}

function clearState() {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE, { force: true });
}

/**
 * 判断守护进程是否存活。
 * Unix 下 kill(pid,0) 即可；Windows 下 Node 的 process.kill 对不存在的进程
 * 会抛 ESRCH，因此同样适用。
 */
function guardAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // 存在但无权限 → 视为存活
  }
}

// ── Git 操作 ─────────────────────────────────────────────────────────────────
function runGit(args: string[], opts: { quiet?: boolean } = {}): { code: number; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  if (r.error) {
    if (!opts.quiet) error(`执行 git 失败: ${r.error.message}`);
    return { code: -1, out: "" };
  }
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

function requireGit() {
  const r = runGit(["--version"], { quiet: true });
  if (r.code !== 0) die("未找到 git，请先安装 Git for Windows 并确保在 PATH 中");
}

/** credentials 文件路径：优先 $HOME，Windows 回退 %USERPROFILE% */
function credentialFilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".git-credentials");
}

function describeCredentialSource(): string {
  const { code, out } = runGit(["config", "--global", "--get", "credential.helper"], {
    quiet: true,
  });
  if (code !== 0 || !out) return "未配置";
  return out;
}

function writeCredentialFile(token: string) {
  const file = credentialFilePath();
  let kept: string[] = [];
  if (existsSync(file)) {
    kept = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.includes("github.com"));
  }
  kept.push(`https://x-access-token:${token}@github.com`);
  writeFileSync(file, kept.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 上可能无效，忽略 */
  }
}

function removeCredentialFile() {
  const file = credentialFilePath();
  if (!existsSync(file)) return false;
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes("github.com"));
  if (kept.length === 0) {
    rmSync(file, { force: true });
    return true;
  }
  writeFileSync(file, kept.join("\n") + "\n", { mode: 0o600 });
  return true;
}

/** 备份并接管 git 全局凭证配置，返回原 credential.helper 值以便恢复 */
function configureGit(token: string, username: string, email: string): string | null {
  const previous = describeCredentialSource();

  runGit(["config", "--global", "user.name", username]);
  runGit(["config", "--global", "user.email", email]);

  // 记录原 helper，便于撤销时还原（如 gh auth git-credential）
  if (previous && previous !== "未配置" && previous !== "store") {
    runGit(["config", "--global", "temp-auth.prevCredentialHelper", previous]);
  }

  runGit(["config", "--global", "credential.helper", "store"]);
  writeCredentialFile(token);

  return previous === "未配置" ? null : previous;
}

function restoreCredentialHelper() {
  const { code, out } = runGit(
    ["config", "--global", "--get", "temp-auth.prevCredentialHelper"],
    { quiet: true },
  );
  if (code === 0 && out) {
    runGit(["config", "--global", "credential.helper", out]);
    runGit(["config", "--global", "--unset", "temp-auth.prevCredentialHelper"]);
    return out;
  }
  runGit(["config", "--global", "--unset", "credential.helper"], { quiet: true });
  return null;
}

function clearGitCredential(restore: boolean) {
  info("正在清除 git 凭证...");
  removeCredentialFile();
  if (restore) {
    const restored = restoreCredentialHelper();
    if (restored) info(`已还原原 credential.helper → ${restored}`);
  }
  info("Git 凭证已清除（user.name / user.email 保留）");
}

// ── 剪贴板（Windows 优先，兼容 macOS / Linux） ───────────────────────────────
/**
 * 写入剪贴板。
 *
 * Windows 注意：不能把内容通过 stdin 喂给 PowerShell —— [Console]::In 默认按
 * 系统 ANSI 代码页(GBK)解码，中文会乱码，且空行可能被吞掉。
 * 因此先以 UTF-8 写临时文件，再让 PowerShell 用 -Encoding UTF8 读回。
 */
function copyToClipboard(text: string): boolean {
  if (IS_WINDOWS) {
    return copyWindows(text);
  }

  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ];

  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, {
      input: text,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

function copyWindows(text: string): boolean {
  const tmp = join(
    process.env.TEMP || process.env.TMP || SCRIPT_DIR,
    `gta-clip-${process.pid}-${Date.now()}.txt`,
  );
  try {
    writeFileSync(tmp, text, "utf8");
    const script =
      `$ErrorActionPreference='Stop';` +
      `$c = Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' -Raw -Encoding UTF8;` +
      `Set-Clipboard -Value $c`;
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (!r.error && r.status === 0) return true;
  } catch {
    /* 落到 clip 兜底 */
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }

  // 兜底：clip.exe。中文可能乱码，但总比没有好
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

// ── GitHub API ───────────────────────────────────────────────────────────────
interface ApiResult {
  ok: boolean;
  status: number;
  body: any;
  raw: string;
}

async function ghFetch(
  path: string,
  init: RequestInit & { masterToken: string },
): Promise<ApiResult> {
  const { masterToken, ...rest } = init;
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${masterToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "git-temp-auth-bun",
      ...(rest.headers ?? {}),
    },
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, raw };
}

async function createFineGrainedToken(
  masterToken: string,
  hours: number,
): Promise<{ tokenId: string; token: string; expiresAt: string }> {
  const expiresAt = isoPlusHours(hours);
  const tokenName = `temp-git-auth-${new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14)}-${process.pid}`;

  info(`正在通过 GitHub API 创建临时 fine-grained token（有效期 ${hours} 小时）...`);

  const r = await ghFetch("/user/tokens", {
    method: "POST",
    masterToken,
    body: JSON.stringify({
      name: tokenName,
      expires_at: expiresAt,
      repository_selection: "all",
      permissions: {
        contents: "write",
        metadata: "read",
      },
    }),
  });

  if (!r.ok) {
    error(`创建 token 失败 (HTTP ${r.status}):`);
    console.error(r.body ? JSON.stringify(r.body, null, 2) : r.raw);
    const msg = (r.body?.message ?? r.raw ?? "").toLowerCase();
    if (msg.includes("manage_tokens") || msg.includes("permission")) {
      warn("母 token 缺少 Manage personal access tokens 权限，请在 GitHub 设置中开启");
    }
    if (msg.includes("expires_at") || msg.includes("expires")) {
      warn("过期时间可能不被接受，请尝试更长时长（如 --hours 24）");
    }
    if (r.status === 401) warn("母 token 无效或已过期，请重新生成并更新 .env");
    if (r.status === 403) warn("母 token 权限不足或被限流");
    process.exit(1);
  }

  const token: string | undefined = r.body?.token;
  const tokenId = String(r.body?.id ?? "");

  if (!token) {
    error("API 响应中未找到 token 字段");
    console.error(JSON.stringify(r.body, null, 2));
    process.exit(1);
  }

  return { tokenId, token, expiresAt };
}

async function revokeToken(masterToken: string, tokenId: string) {
  if (!tokenId) return;
  info(`正在撤销 GitHub token (ID: ${tokenId})...`);
  try {
    const r = await ghFetch(`/user/tokens/${tokenId}`, {
      method: "DELETE",
      masterToken,
    });
    if (r.status === 204) info("Token 已从 GitHub 撤销");
    else if (r.status === 404) info("Token 不存在（可能已过期或已被删除）");
    else warn(`撤销 token 返回 HTTP ${r.status}`);
  } catch (e: any) {
    warn(`撤销 token 请求失败: ${e?.message ?? e}`);
  }
}

async function verifyMasterToken(masterToken: string): Promise<number> {
  try {
    const r = await ghFetch("/user", { masterToken });
    return r.status;
  } catch {
    return 0;
  }
}

// ── 一键粘贴命令 ─────────────────────────────────────────────────────────────
function buildPasteCommand(args: {
  token: string;
  username: string;
  email: string;
  expiresAt: string;
  expiresLocal: string;
}): string {
  const { token, username, email, expiresAt, expiresLocal } = args;
  const credentialFile = credentialFilePath();
  const lines: string[] = [];
  lines.push(`# ===== git-temp-auth 一键配置 =====`);
  lines.push(`# 用户     : ${username} <${email}>`);
  lines.push(`# 过期时间 : ${expiresAt} (UTC)`);
  lines.push(`# 本地时间 : ${expiresLocal}`);
  lines.push(`# 目标账号 : github.com`);
  lines.push("");
  if (IS_WINDOWS) {
    lines.push(`git config --global user.name "${username}"`);
    lines.push(`git config --global user.email "${email}"`);
    lines.push(`git config --global credential.helper store`);
    lines.push(`git config --global --unset temp-auth.prevCredentialHelper`);
    lines.push(
      `Set-Content -Path "${credentialFile}" -Value "https://x-access-token:${token}@github.com" -Encoding ascii`,
    );
    lines.push(`# CMD 用户改用下面这行：`);
    lines.push(`# echo https://x-access-token:${token}@github.com>"${credentialFile}"`);
  } else {
    lines.push(`git config --global user.name "${username}"`);
    lines.push(`git config --global user.email "${email}"`);
    lines.push(`git config --global credential.helper store`);
    lines.push(`git config --global --unset temp-auth.prevCredentialHelper`);
    lines.push(`echo 'https://x-access-token:${token}@github.com' > "${credentialFile}"`);
  }
  lines.push("");
  lines.push(`# 过期后手动清理：`);
  lines.push(`# git config --global --unset credential.helper`);
  return lines.join("\n");
}

// ── 守护进程：到期撤销 ───────────────────────────────────────────────────────
async function runGuard(hours: number, tokenId: string, restoreHelper: boolean) {
  const log = (m: string) => appendFileSync(LOG_FILE, `[${nowIso()}] ${m}\n`);

  log(`guard started pid=${process.pid} expire_in=${hours}h token_id=${tokenId}`);

  // 分段睡眠，避免超长 setTimeout 溢出（Node 上限约 24.8 天）
  let remainingMs = hours * 3600 * 1000;
  const CHUNK = 60 * 60 * 1000; // 每次最多睡 1 小时
  while (remainingMs > 0) {
    const slice = Math.min(remainingMs, CHUNK);
    await new Promise((r) => setTimeout(r, slice));
    remainingMs -= slice;
  }

  log("guard expired, revoking...");

  let masterToken = process.env.GITHUB_MASTER_TOKEN ?? "";
  if (!masterToken) {
    // 独立进程可能没有继承 env，从 .env 重新读取
    masterToken = parseEnvFile(ENV_FILE).GITHUB_MASTER_TOKEN ?? "";
  }

  if (masterToken && tokenId) {
    await revokeToken(masterToken, tokenId);
  } else {
    log(`skip revoke: masterToken=${!!masterToken} tokenId=${tokenId}`);
  }

  removeCredentialFile();
  if (restoreHelper) restoreCredentialHelper();
  clearState();

  log("done. token revoked, git cleared.");
  process.exit(0);
}

/** 以分离进程方式后台启动守护进程 */
function spawnGuard(hours: number, tokenId: string, restoreHelper: boolean): number {
  const child = spawn(
    process.execPath,
    [SCRIPT_PATH, "_guard", String(hours), tokenId, restoreHelper ? "restore" : "norestore"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: SCRIPT_DIR,
    },
  );
  child.unref();
  return child.pid ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  命令实现
// ═════════════════════════════════════════════════════════════════════════════

function ensureEnvTemplate() {
  if (existsSync(ENV_FILE)) return;
  writeFileSync(
    ENV_FILE,
    [
      "# git-temp-auth 配置（请勿提交到 git，勿泄露）",
      "#",
      "# 母 token：GitHub fine-grained PAT，仅需 Manage personal access tokens = Read and write",
      "#   创建地址 https://github.com/settings/personal-access-tokens/new",
      "#   Permissions → Account permissions → Manage personal access tokens → Read and write",
      "#   Expiration 可设较长（如 1 年），因为它权限极小、不碰仓库数据",
      "GITHUB_MASTER_TOKEN=",
      "",
      "# git 提交身份",
      "GIT_USERNAME=",
      "GIT_EMAIL=",
      "",
      "# 默认授权时长（小时），可被 --hours 覆盖",
      "GIT_TEMP_HOURS=1",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  info(`已生成配置模板 → ${ENV_FILE}`);
}

async function cmdInit() {
  box("git-temp-auth  初始化配置");
  console.log("");
  console.log("你需要准备一个【母 token】，仅用于创建/撤销临时子 token：");
  console.log("");
  console.log("  1. 打开 " + CYAN("https://github.com/settings/personal-access-tokens/new"));
  console.log("  2. Token type 选 Fine-grained");
  console.log("  3. Repository access 选 All repositories（或按需）");
  console.log("  4. Permissions → Account permissions → Manage personal access tokens → Read and write");
  console.log("  5. 过期时间可设较长（如 1 年）");
  console.log("  6. 生成后复制 token 值");
  console.log("");
  warn("母 token 不会配置到 git，仅保存在本地 .env（权限 600）");
  console.log("");

  ensureEnvTemplate();

  const cur = parseEnvFile(ENV_FILE);
  const ask = (q: string, def: string) => {
    const answer = prompt(`${q}${def ? ` [${def}]` : ""}: `) ?? "";
    return answer.trim() || def;
  };

  const masterToken = ask("请输入母 token", cur.GITHUB_MASTER_TOKEN ?? "");
  if (!masterToken) die("token 不能为空");

  const username = ask("请输入 git username", cur.GIT_USERNAME ?? "");
  if (!username) die("username 不能为空");

  const email = ask("请输入 git email", cur.GIT_EMAIL ?? "");
  if (!email) die("email 不能为空");

  writeFileSync(
    ENV_FILE,
    [
      "# git-temp-auth 配置（请勿提交到 git，勿泄露）",
      `GITHUB_MASTER_TOKEN=${masterToken}`,
      `GIT_USERNAME=${username}`,
      `GIT_EMAIL=${email}`,
      `GIT_TEMP_HOURS=${cur.GIT_TEMP_HOURS ?? "1"}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  info(`配置已保存 → ${ENV_FILE}`);

  process.env.GITHUB_MASTER_TOKEN = masterToken;

  info("正在验证母 token 有效性...");
  await verify(masterToken, username, email);
}

async function verify(masterToken: string, username: string, email: string) {
  const code = await verifyMasterToken(masterToken);
  if (code === 200) {
    info("母 token 验证通过 ✓");
  } else if (code === 0) {
    warn("无法连接 GitHub API，请检查网络/代理");
  } else {
    warn(`母 token 验证返回 HTTP ${code}，请检查 token 是否正确`);
    warn("（验证 /user 只确认 token 有效，manage_tokens 权限需在创建时才会校验）");
  }

  console.log("");
  label("初始化完成！常用命令：");
  console.log(`  bun ${SCRIPT_PATH}                创建临时授权（默认 ${process.env.GIT_TEMP_HOURS ?? 1} 小时）`);
  console.log(`  bun ${SCRIPT_PATH} --hours 5      创建 5 小时临时授权`);
  console.log(`  bun ${SCRIPT_PATH} status         查看当前授权状态`);
  console.log(`  bun ${SCRIPT_PATH} revoke         手动撤销当前授权`);
  console.log(`  bun ${SCRIPT_PATH} help           查看全部命令`);
}

function parseArgs(argv: string[]): { hours: number; noClipboard: boolean; yes: boolean } {
  const fileEnv = parseEnvFile(ENV_FILE);
  const defHours = Number(process.env.GIT_TEMP_HOURS ?? fileEnv.GIT_TEMP_HOURS ?? 1) || 1;
  let hours = defHours;
  let noClipboard = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hours" || a === "-h") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1) die("--hours 必须是正整数");
      hours = n;
    } else if (a.startsWith("--hours=")) {
      const n = Number(a.split("=")[1]);
      if (!Number.isInteger(n) || n < 1) die("--hours 必须是正整数");
      hours = n;
    } else if (a === "--no-clipboard") {
      noClipboard = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else {
      error(`未知参数: ${a}`);
      console.log(`用法: bun ${SCRIPT_PATH} [--hours N] [--no-clipboard] [--yes]`);
      process.exit(1);
    }
  }
  return { hours, noClipboard, yes };
}

async function cmdStart(argv: string[]) {
  const { hours, noClipboard, yes } = parseArgs(argv);

  requireGit();

  // 检查已有活跃授权
  const prevState = loadState();
  if (prevState?.tokenId) {
    if (guardAlive(prevState.guardPid)) {
      warn(
        `检测到已有活跃授权 (Token ID: ${prevState.tokenId}, 过期: ${prevState.expiresAt} UTC)`,
      );
      let ok = yes;
      if (!yes) {
        const a = (prompt("撤销旧授权并创建新的？(y/N): ") ?? "").trim().toLowerCase();
        ok = a === "y" || a === "yes";
      }
      if (!ok) {
        info("已取消");
        return;
      }
      await doRevoke();
    } else {
      warn("发现残留状态但守护进程已退出，正在清理...");
      const cfg = loadConfig();
      await revokeToken(cfg.masterToken, prevState.tokenId);
      clearGitCredential(true);
      clearState();
    }
  }

  const cfg = loadConfig();

  const { tokenId, token, expiresAt } = await createFineGrainedToken(cfg.masterToken, hours);

  const previousHelper = configureGit(token, cfg.username, cfg.email);
  const restoreNeeded = previousHelper !== null && previousHelper !== "store";
  if (previousHelper && previousHelper !== "store") {
    info(`已记录原 credential.helper（撤销时还原）: ${previousHelper}`);
  }

  const guardPid = spawnGuard(hours, tokenId, restoreNeeded);

  const expireEpoch = Math.floor(new Date(expiresAt).getTime() / 1000);
  saveState({
    tokenId,
    token,
    expiresAt,
    expireEpoch,
    guardPid,
    createdAt: nowIso(),
    hours,
  });

  const expiresLocal = formatLocal(expiresAt);

  box("临时授权已启用");
  console.log(`  Token ID      : ${tokenId}`);
  console.log(`  有效期        : ${hours} 小时`);
  console.log(`  过期时间(UTC) : ${expiresAt}`);
  console.log(`  过期时间(本地): ${expiresLocal}`);
  console.log(`  Git 用户      : ${cfg.username} <${cfg.email}>`);
  console.log(`  守护进程      : PID ${guardPid}`);
  console.log("");
  info("git 已配置完成，可直接 git push / git clone");

  // ── 一键粘贴命令 ────────────────────────────────────────────────────────
  const pasteCmd = buildPasteCommand({
    token,
    username: cfg.username,
    email: cfg.email,
    expiresAt,
    expiresLocal,
  });

  const copied = noClipboard ? false : copyToClipboard(pasteCmd);

  box("一键粘贴配置命令");
  console.log("");
  console.log(pasteCmd);
  console.log("");
  if (copied) {
    info("✓ 以上命令已复制到剪贴板，直接在目标终端 Ctrl+V 回车即可");
  } else {
    warn("剪贴板写入失败，请手动复制上面内容");
  }
  console.log("");
  console.log(DIM("─".repeat(50)));
  console.log(`  ${DIM("Token     :")} ${DIM(token)}`);
  console.log(`  ${DIM("Username  :")} ${DIM(cfg.username)}`);
  console.log(`  ${DIM("Email     :")} ${DIM(cfg.email)}`);
  console.log(`  ${DIM("过期(UTC) :")} ${DIM(expiresAt)}`);
  console.log(`  ${DIM("过期(本地):")} ${DIM(expiresLocal)}`);
  console.log(DIM("─".repeat(50)));
  console.log("");
  warn(`关闭终端不影响守护进程，到期自动撤销（PID ${guardPid}）`);
  warn(`提前撤销: bun ${SCRIPT_PATH} revoke`);
}

function cmdStatus() {
  const s = loadState();
  if (!s) {
    info("当前没有活跃的临时授权");
    return;
  }

  box("当前临时授权状态");
  console.log(`  Token ID      : ${s.tokenId}`);
  console.log(`  创建时间(UTC) : ${s.createdAt || "未知"}`);
  console.log(`  过期时间(UTC) : ${s.expiresAt}`);
  console.log(`  过期时间(本地): ${formatLocal(s.expiresAt)}`);
  console.log(`  守护进程 PID  : ${s.guardPid || "未知"}`);
  console.log(`  credential    : ${describeCredentialSource()}`);

  if (guardAlive(s.guardPid)) {
    console.log(`  状态          : ${GREEN("运行中")}`);
    const remaining = s.expireEpoch - Math.floor(Date.now() / 1000);
    if (remaining > 0) {
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      console.log(`  剩余时间      : ${h} 小时 ${m} 分钟`);
    } else {
      console.log(`  剩余时间      : ${RED("已过期")}`);
    }
  } else {
    console.log(`  状态          : ${YELLOW("守护进程已退出（可能已过期或被终止）")}`);
  }
  console.log("");
  console.log(`  ${DIM("Token: " + (s.token ? s.token.slice(0, 12) + "..." : "无"))}`);
}

async function doRevoke(forRestore = true) {
  const s = loadState();
  if (!s) {
    info("当前没有活跃的临时授权");
    return;
  }

  if (guardAlive(s.guardPid)) {
    try {
      process.kill(s.guardPid);
      info("守护进程已终止");
    } catch {
      /* 已退出 */
    }
  }

  const fileEnv = parseEnvFile(ENV_FILE);
  const masterToken = process.env.GITHUB_MASTER_TOKEN ?? fileEnv.GITHUB_MASTER_TOKEN ?? "";
  if (masterToken) {
    await revokeToken(masterToken, s.tokenId);
  } else {
    warn("未找到母 token，跳过 GitHub 端撤销（本地凭证仍会清除）");
  }

  clearGitCredential(forRestore);
  clearState();
  info("临时授权已完全撤销 ✓");
}

function cmdHelp() {
  console.log(`
${CYAN("git-temp-auth")} — 临时 GitHub 身份配置工具（Bun / Windows 版）

用法:
  bun git-temp-auth.ts [命令] [选项]

命令:
  (无)              创建临时授权并配置 git（默认 1 小时）
  init              交互式生成/更新 .env 配置
  status            查看当前授权状态与剩余时间
  revoke            手动撤销当前授权（删 token + 清 git 凭证）
  help              显示此帮助

选项:
  --hours N         授权时长（小时），默认取 .env 的 GIT_TEMP_HOURS
  --no-clipboard    不把一键命令写入剪贴板
  --yes, -y         跳过「覆盖已有授权」的确认

示例:
  bun git-temp-auth.ts init              # 首次使用，写入 .env
  bun git-temp-auth.ts                   # 授权 1 小时
  bun git-temp-auth.ts --hours 5         # 授权 5 小时
  bun git-temp-auth.ts status            # 查看状态
  bun git-temp-auth.ts revoke            # 提前撤销

工作原理:
  1. 启动时 Bun 自动读取同目录 .env（GITHUB_MASTER_TOKEN / GIT_USERNAME / GIT_EMAIL）
  2. 用母 token（仅 manage_tokens 权限）调用 GitHub API 创建短期 fine-grained PAT
  3. 将子 token 写入 git credential helper（store）
  4. 输出一键粘贴命令并复制到剪贴板
  5. 后台分离进程睡眠 N 小时后自动：撤销子 token + 清除 git 凭证

配置文件:
  ${ENV_FILE}
`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  主入口
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // 无参数，或直接跟选项（如 --hours 5）→ 默认执行 start
  const isOption = !!cmd && cmd.startsWith("-") && cmd !== "--help" && cmd !== "-h";

  switch (true) {
    case cmd === undefined || isOption || cmd === "start" || cmd === "run":
      await cmdStart(isOption ? args : args.slice(1));
      break;
    case cmd === "init":
      await cmdInit();
      break;
    case cmd === "status":
      cmdStatus();
      break;
    case cmd === "revoke":
      await doRevoke();
      break;
    case cmd === "_guard": {
      const hours = Number(args[1] ?? 0);
      const tokenId = args[2] ?? "";
      const restore = args[3] === "restore";
      await runGuard(hours, tokenId, restore);
      break;
    }
    case cmd === "help" || cmd === "--help" || cmd === "-h":
      cmdHelp();
      break;
    default:
      error(`未知命令: ${cmd}`);
      console.log(`运行 bun ${SCRIPT_PATH} help 查看用法`);
      process.exit(1);
  }
}

main().catch((e) => {
  error(e?.stack ?? String(e));
  process.exit(1);
});
