#!/usr/bin/env bun
// =============================================================================
// git-temp-token — 临时 GitHub Token 生成器（纯生成版 / 可打包 exe）
//
// 设计目标：
//   双击运行 → 读取同级 .env → 调 GitHub API 创建短期 token
//   → 屏幕输出 + 自动复制到剪贴板的配置信息 → 等按键退出
//
// 重要：本程序【不修改本机任何 git 配置】，不写凭证、不设 helper、不起守护进程。
//      它只负责「生成信息给你复制到别处用」。
//
// 依赖：无需外部依赖（打包后单文件可运行）
// 兼容：Windows（主要）/ macOS / Linux
//
// 使用：
//   双击 exe                      → 默认生成，时长取 .env 的 GIT_TEMP_HOURS
//   命令行: git-temp-token.exe --hours 5
//           git-temp-token.exe --json      仅输出 JSON（便于管道）
//           git-temp-token.exe --no-clipboard
// =============================================================================

import { existsSync, readFileSync, writeFileSync, rmSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// ── 路径解析（编译成 exe 后的关键部分） ──────────────────────────────────────
/**
 * 取得 exe（或脚本）所在目录。
 *
 * 坑：编译成 exe 后 process.argv[0] 返回字符串 "bun"，argv[1] 是虚拟路径
 *     "B:/~BUN/root/xxx.exe"，两者都不能用来定位真实文件。
 *     只有 process.execPath 返回真实 exe 绝对路径。
 *
 * 判断是否运行在编译后的 exe 中：argv[0] === "bun" 时是编译产物。
 */
const IS_COMPILED = process.argv[0] === "bun";

const APP_DIR = (() => {
  if (IS_COMPILED) {
    // 编译后：execPath 就是 exe 的真实路径
    return dirname(process.execPath);
  }
  // 源码运行：argv[1] 是脚本路径
  const script = process.argv[1];
  if (script && existsSync(script)) return dirname(script);
  return process.cwd();
})();

const ENV_FILE = join(APP_DIR, ".env");

// 可用环境变量覆盖，便于测试或 GitHub Enterprise
const GITHUB_API =
  process.env.GITHUB_API_BASE?.replace(/\/$/, "") || "https://api.github.com";
const API_VERSION = "2022-11-28";

const IS_WINDOWS = process.platform === "win32";

// ── 颜色 ─────────────────────────────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
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

function hr() {
  console.log(DIM("─".repeat(58)));
}

function section(title: string) {
  console.log("");
  hr();
  label(`  ${title}`);
  hr();
}

// ── .env 读取（显式读取 exe 同级目录，不依赖 cwd） ────────────────────────────
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
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    // 去掉行尾注释（未加引号时）
    out[key] = val;
  }
  return out;
}

interface Config {
  masterToken: string;
  username: string;
  email: string;
  defaultHours: number;
}

function loadConfig(): Config {
  const fileEnv = parseEnvFile(ENV_FILE);

  const fromEnv = (k: string) => process.env[k] ?? "";
  const masterToken = fromEnv("GITHUB_MASTER_TOKEN") || fileEnv.GITHUB_MASTER_TOKEN || "";
  const username = fromEnv("GIT_USERNAME") || fileEnv.GIT_USERNAME || "";
  const email = fromEnv("GIT_EMAIL") || fileEnv.GIT_EMAIL || "";
  const hoursRaw = fromEnv("GIT_TEMP_HOURS") || fileEnv.GIT_TEMP_HOURS || "1";
  const defaultHours = Number(hoursRaw) || 1;

  return { masterToken, username, email, defaultHours };
}

/** 生成 .env 模板（首次双击、没有 .env 时自动创建并说明） */
function createEnvTemplate() {
  const tpl = [
    "# ============================================================",
    "# git-temp-token 配置",
    "#",
    "# 母 token：GitHub fine-grained PAT",
    "#   1. 打开 https://github.com/settings/personal-access-tokens/new",
    "#   2. Token type 选 Fine-grained",
    "#   3. Repository access 选 All repositories（或按需）",
    "#   4. Permissions -> Account permissions",
    "#      -> Manage personal access tokens -> Read and write",
    "#   5. 过期时间可设较长（如 1 年），因为它权限极小",
    "#   6. 生成后把 token 粘贴到下面",
    "# ============================================================",
    "",
    "GITHUB_MASTER_TOKEN=",
    "",
    "# 要配置到目标机器的 git 身份",
    "GIT_USERNAME=",
    "GIT_EMAIL=",
    "",
    "# 默认授权时长（小时）",
    "GIT_TEMP_HOURS=1",
    "",
  ].join("\r\n"); // Windows 记事本友好
  writeFileSync(ENV_FILE, tpl, "utf8");
}

// ── 时间工具 ─────────────────────────────────────────────────────────────────
function isoPlusHours(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
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

// ── 剪贴板（Windows 优先，UTF-8 安全） ───────────────────────────────────────
/**
 * 坑：不能把内容通过 stdin 喂给 PowerShell —— [Console]::In 按系统 ANSI
 *     代码页(GBK)解码，中文会乱码。改为先写 UTF-8 临时文件，再让
 *     PowerShell 用 [System.IO.File]::ReadAllText(..., UTF8) 读回。
 */
function copyToClipboard(text: string): boolean {
  if (IS_WINDOWS) {
    const tmp = join(
      process.env.TEMP || process.env.TMP || APP_DIR,
      `gtt-clip-${process.pid}-${Date.now()}.txt`,
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
    // 兜底：clip.exe
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
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

// ── GitHub API ───────────────────────────────────────────────────────────────
interface CreateResult {
  tokenId: string;
  token: string;
  expiresAt: string;
  tokenName: string;
}

async function createToken(
  masterToken: string,
  hours: number,
): Promise<CreateResult> {
  const expiresAt = isoPlusHours(hours);
  const tokenName = `temp-token-${new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14)}`;

  info(`正在请求 GitHub 创建临时 token（有效期 ${hours} 小时）...`);

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/user/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "git-temp-token",
        "Content-Type": "application/json",
      },
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
  } catch (e: any) {
    error(`无法连接 GitHub API: ${e?.message ?? e}`);
    warn("请检查网络或代理设置");
    process.exit(1);
  }

  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    error(`创建 token 失败 (HTTP ${res.status})`);
    console.error(body ? JSON.stringify(body, null, 2) : raw);
    const msg = String(body?.message ?? raw ?? "").toLowerCase();
    if (res.status === 401) {
      warn("母 token 无效或已过期 —— 请重新生成并更新 .env 的 GITHUB_MASTER_TOKEN");
    } else if (res.status === 404) {
      warn("母 token 无效或权限不足（GitHub 对无权限的 token 会返回 404 而非 403）");
      warn("请确认母 token 已开启：Account permissions");
      warn("  -> Manage personal access tokens -> Read and write");
    } else if (res.status === 403) {
      warn("母 token 权限不足或被限流（rate limit）");
    }
    if (msg.includes("manage_tokens")) {
      warn("缺少 Manage personal access tokens 权限");
    }
    if (msg.includes("expires")) {
      warn("过期时间不被接受，请尝试更长时长（如 --hours 24）");
    }
    process.exit(1);
  }

  const token: string | undefined = body?.token;
  if (!token) {
    error("API 响应中没有 token 字段");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  return { tokenId: String(body?.id ?? ""), token, expiresAt, tokenName };
}

// ── 输出内容构造 ─────────────────────────────────────────────────────────────
interface OutputBundle {
  /** 给人看的完整文本（会自动进剪贴板、也会打印） */
  text: string;
  /** 结构化数据，供 --json 用 */
  data: Record<string, unknown>;
}

function buildOutput(args: {
  token: string;
  tokenId: string;
  username: string;
  email: string;
  hours: number;
  expiresAt: string;
}): OutputBundle {
  const { token, tokenId, username, email, hours, expiresAt } = args;
  const local = formatLocal(expiresAt);

  const lines: string[] = [];
  lines.push("# ====== GitHub 临时 Token 配置信息 ======");
  lines.push(`# 有效期   : ${hours} 小时`);
  lines.push(`# 过期时间 : ${expiresAt} (UTC)`);
  lines.push(`# 本地时间 : ${local}`);
  lines.push(`# Token ID : ${tokenId}`);
  lines.push("");
  lines.push("# --- 基本信息（复制到任意地方使用） ---");
  lines.push(`Token    : ${token}`);
  lines.push(`Username : ${username}`);
  lines.push(`Email    : ${email}`);
  lines.push(`Expires  : ${expiresAt}`);
  lines.push("");
  lines.push("# --- git 配置命令（在目标机器执行） ---");
  lines.push(`git config --global user.name "${username}"`);
  lines.push(`git config --global user.email "${email}"`);
  lines.push(`git config --global credential.helper store`);
  lines.push("");
  lines.push("# --- 凭证文件（目标机器） ---");
  lines.push(`# PowerShell:`);
  lines.push(
    `Set-Content -Path "$HOME\\.git-credentials" -Value "https://x-access-token:${token}@github.com" -Encoding ascii`,
  );
  lines.push(`# Bash / Git Bash:`);
  lines.push(`echo 'https://x-access-token:${token}@github.com' > ~/.git-credentials`);
  lines.push("");
  lines.push("# --- 一行式（PowerShell，直接粘贴） ---");
  lines.push(
    `git config --global user.name "${username}"; git config --global user.email "${email}"; ` +
      `git config --global credential.helper store; ` +
      `Set-Content -Path "$HOME\\.git-credentials" -Value "https://x-access-token:${token}@github.com" -Encoding ascii`,
  );

  return {
    text: lines.join("\n"),
    data: {
      token,
      token_id: tokenId,
      username,
      email,
      expires_at: expiresAt,
      expires_at_local: local,
      hours,
    },
  };
}

// ── 等待按键（双击场景关键） ─────────────────────────────────────────────────
/**
 * 双击运行时窗口会在程序结束后立即关闭，用户来不及复制。
 * 这里用同步方式等待回车。仅在交互式终端才等待，避免管道/CI 卡死。
 */
function pauseIfNeeded() {
  const interactive =
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !process.env.GTT_NO_PAUSE;

  if (!interactive) return;

  console.log("");
  console.log(DIM("按 Enter 键退出..."));
  try {
    const buf = Buffer.alloc(1);
    // 阻塞式读取一个字符（回车即返回）
    while (true) {
      const n = readSyncFd(buf);
      if (n <= 0) break;
      const ch = buf[0];
      if (ch === 0x0a || ch === 0x0d || ch === 0x20 || ch === 0x1b) break;
    }
  } catch {
    /* 读不到就退出 */
  }
}

/** 同步读一个字节 */
function readSyncFd(buf: Buffer): number {
  try {
    return readSync(0, buf, 0, 1, null);
  } catch {
    return 0;
  }
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────
interface Args {
  hours?: number;
  json: boolean;
  noClipboard: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, noClipboard: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--hours" || v === "-h") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        error("--hours 必须是正整数");
        process.exit(1);
      }
      a.hours = n;
    } else if (v.startsWith("--hours=")) {
      const n = Number(v.slice(8));
      if (!Number.isInteger(n) || n < 1) {
        error("--hours 必须是正整数");
        process.exit(1);
      }
      a.hours = n;
    } else if (v === "--json") {
      a.json = true;
    } else if (v === "--no-clipboard") {
      a.noClipboard = true;
    } else if (v === "--help" || v === "--?") {
      a.help = true;
    } else {
      error(`未知参数: ${v}`);
      console.log("运行 --help 查看用法");
      process.exit(1);
    }
  }
  return a;
}

function printHelp() {
  console.log(`
${CYAN("git-temp-token")} — 临时 GitHub Token 生成器

生成一个短期 GitHub token，输出可直接复制的配置信息。
本程序不会修改你本机的任何 git 配置。

用法:
  git-temp-token.exe [选项]

选项:
  --hours N         授权时长（小时），默认取 .env 的 GIT_TEMP_HOURS
  --json            以 JSON 格式输出（便于脚本处理）
  --no-clipboard    不写入剪贴板，仅屏幕显示
  --help            显示此帮助

配置文件:
  ${ENV_FILE}
  需包含 GITHUB_MASTER_TOKEN / GIT_USERNAME / GIT_EMAIL

示例:
  git-temp-token.exe                # 双击等价，默认时长
  git-temp-token.exe --hours 5      # 5 小时
  git-temp-token.exe --json         # 输出 JSON
`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  主流程
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    pauseIfNeeded();
    return;
  }

  // 无 .env → 生成模板并引导
  if (!existsSync(ENV_FILE)) {
    createEnvTemplate();
    section("首次使用");
    warn(`未找到配置文件，已自动生成模板：`);
    console.log(`  ${ENV_FILE}`);
    console.log("");
    console.log("请用记事本打开它，填入以下三项后重新运行：");
    console.log("  GITHUB_MASTER_TOKEN  — 母 token（需 manage_tokens 权限）");
    console.log("  GIT_USERNAME         — git 用户名");
    console.log("  GIT_EMAIL            — git 邮箱");
    console.log("");
    console.log(DIM("母 token 创建地址："));
    console.log(CYAN("https://github.com/settings/personal-access-tokens/new"));
    pauseIfNeeded();
    return;
  }

  const cfg = loadConfig();
  const hours = args.hours ?? cfg.defaultHours;

  const missing = [
    !cfg.masterToken && "GITHUB_MASTER_TOKEN",
    !cfg.username && "GIT_USERNAME",
    !cfg.email && "GIT_EMAIL",
  ].filter(Boolean) as string[];

  if (missing.length) {
    section("配置不完整");
    error(`以下项目为空: ${missing.join(", ")}`);
    console.log(`  请编辑: ${ENV_FILE}`);
    pauseIfNeeded();
    process.exit(1);
  }

  const result = await createToken(cfg.masterToken, hours);
  const bundle = buildOutput({
    token: result.token,
    tokenId: result.tokenId,
    username: cfg.username,
    email: cfg.email,
    hours,
    expiresAt: result.expiresAt,
  });

  // --json 模式：只打印 JSON
  if (args.json) {
    console.log(JSON.stringify(bundle.data, null, 2));
    return;
  }

  const copied = args.noClipboard ? false : copyToClipboard(bundle.text);

  section("生成成功");
  console.log(`  Token ID      : ${result.tokenId}`);
  console.log(`  有效期        : ${hours} 小时`);
  console.log(`  过期时间(UTC) : ${result.expiresAt}`);
  console.log(`  过期时间(本地): ${formatLocal(result.expiresAt)}`);
  console.log(`  Git 用户      : ${cfg.username} <${cfg.email}>`);
  console.log("");

  if (copied) {
    info("完整配置信息已复制到剪贴板，可直接粘贴到任何地方");
  } else {
    warn("剪贴板写入失败，请手动选中下方内容复制");
  }

  section("配置信息（可直接复制）");
  console.log(bundle.text);
  console.log("");
  hr();
  console.log(DIM("  本程序未修改你本机的任何 git 配置"));
  hr();

  pauseIfNeeded();
}

main().catch((e) => {
  error(e?.stack ?? String(e));
  pauseIfNeeded();
  process.exit(1);
});
