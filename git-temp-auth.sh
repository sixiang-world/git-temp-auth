#!/usr/bin/env bash
# =============================================================================
# git-temp-auth — 临时 GitHub 身份配置工具
#
# 功能：
#   1. 通过 GitHub API 自动创建短期 fine-grained PAT（可设 1~N 小时过期）
#   2. 自动配置 git 全局 user.name / user.email / credential
#   3. 后台守护进程到期自动撤销 token 并清除本地 git 凭证
#   4. 支持手动查看状态、提前撤销
#
# 依赖：bash 4+, curl, jq, git
# 兼容：Linux / macOS
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config"
STATE_FILE="$SCRIPT_DIR/.state"
LOG_FILE="$SCRIPT_DIR/.expire.log"

GITHUB_API="https://api.github.com"
API_VERSION="2022-11-28"

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
label() { echo -e "${CYAN}$*${NC}"; }

# ── 工具函数 ─────────────────────────────────────────────────────────────────
require_cmd() {
    if ! command -v "$1" &>/dev/null; then
        error "缺少依赖命令: $1 （请先安装）"
        exit 1
    fi
}

# 跨平台 date：输出 UTC ISO8601（+N 小时后）
date_plus_hours_iso() {
    local h="$1"
    if date -u -d "+${h} hours" +%Y-%m-%dT%H:%M:%SZ &>/dev/null; then
        date -u -d "+${h} hours" +%Y-%m-%dT%H:%M:%SZ          # Linux GNU date
    else
        date -u -v+"${h}"H +%Y-%m-%dT%H:%M:%SZ                 # macOS BSD date
    fi
}

# 跨平台 date：ISO8601 → epoch
date_iso_to_epoch() {
    local iso="$1"
    if date -d "$iso" +%s &>/dev/null; then
        date -d "$iso" +%s                                      # Linux
    else
        date -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null \
            || date -j -f "%Y-%m-%dT%H:%M:%S%z" "$iso" +%s      # macOS
    fi
}

# ── 配置管理 ─────────────────────────────────────────────────────────────────
load_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        error "配置文件不存在: $CONFIG_FILE"
        error "请先运行: $0 init"
        exit 1
    fi
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    if [[ -z "${GITHUB_MASTER_TOKEN:-}" || -z "${GIT_USERNAME:-}" || -z "${GIT_EMAIL:-}" ]]; then
        error "配置不完整，请检查 $CONFIG_FILE 或重新运行 $0 init"
        exit 1
    fi
}

save_state() {
    # $1=token_id  $2=token  $3=expires_iso  $4=expire_epoch  $5=guard_pid
    cat > "$STATE_FILE" <<EOF
TOKEN_ID='$1'
TOKEN='$2'
EXPIRES_AT='$3'
EXPIRE_EPOCH='$4'
GUARD_PID='$5'
CREATED_AT='$(date -u +%Y-%m-%dT%H:%M:%SZ)'
HOURS='$6'
EOF
    chmod 600 "$STATE_FILE"
}

load_state() {
    if [[ -f "$STATE_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$STATE_FILE"
    fi
}

clear_state() { rm -f "$STATE_FILE"; }

guard_alive() {
    [[ -n "${GUARD_PID:-}" ]] && kill -0 "$GUARD_PID" 2>/dev/null
}

# ── GitHub API ───────────────────────────────────────────────────────────────
create_fine_grained_token() {
    local hours="$1"
    local expire_iso
    expire_iso=$(date_plus_hours_iso "$hours")

    local token_name="temp-git-auth-$(date +%Y%m%d-%H%M%S)-$$"

    info "正在通过 GitHub API 创建临时 fine-grained token（有效期 ${hours} 小时）..."

    local response http_code
    response=$(curl -sS -w "\n%{http_code}" -X POST \
        -H "Authorization: Bearer ${GITHUB_MASTER_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: ${API_VERSION}" \
        "$GITHUB_API/user/tokens" \
        -d "$(cat <<JSON
{
  "name": "${token_name}",
  "expires_at": "${expire_iso}",
  "repository_selection": "all",
  "repository_permissions": {
    "contents": "write",
    "metadata": "read"
  }
}
JSON
)")

    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" != "201" ]]; then
        error "创建 token 失败 (HTTP $http_code):"
        echo "$body" | jq . >&2 || echo "$body" >&2
        # 常见错误提示
        if echo "$body" | grep -qi "manage_tokens"; then
            warn "母 token 缺少 manage_tokens 权限，请在 GitHub 设置中开启"
        fi
        if echo "$body" | grep -qi "expires_at"; then
            warn "过期时间可能不被接受，请尝试更长的时长（如 --hours 24）"
        fi
        exit 1
    fi

    local token_id token
    token_id=$(echo "$body" | jq -r '.id')
    token=$(echo "$body" | jq -r '.token')

    if [[ -z "$token" || "$token" == "null" ]]; then
        error "API 响应中未找到 token 字段"
        echo "$body" | jq . >&2
        exit 1
    fi

    echo "${token_id}|${token}|${expire_iso}"
}

revoke_token() {
    local token_id="${1:-}"
    [[ -z "$token_id" ]] && return 0

    info "正在撤销 GitHub token (ID: $token_id)..."
    local http_code
    http_code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
        -H "Authorization: Bearer ${GITHUB_MASTER_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: ${API_VERSION}" \
        "$GITHUB_API/user/tokens/$token_id")

    if [[ "$http_code" == "204" ]]; then
        info "Token 已从 GitHub 撤销"
    elif [[ "$http_code" == "404" ]]; then
        info "Token 不存在（可能已过期或已被删除）"
    else
        warn "撤销 token 返回 HTTP $http_code"
    fi
}

verify_master_token() {
    local token="$1"
    local http_code
    http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $token" \
        -H "Accept: application/vnd.github+json" \
        "$GITHUB_API/user")
    echo "$http_code"
}

# ── Git 配置 ─────────────────────────────────────────────────────────────────
configure_git() {
    local token="$1"
    info "正在配置 git 全局身份..."

    git config --global user.name  "$GIT_USERNAME"
    git config --global user.email "$GIT_EMAIL"

    # 使用 store 型 credential helper
    git config --global credential.helper store

    # 写入 ~/.git-credentials（先清除旧的 github.com 条目）
    local cred_file="$HOME/.git-credentials"
    if [[ -f "$cred_file" ]]; then
        grep -v "github.com" "$cred_file" > "${cred_file}.tmp" 2>/dev/null || true
        mv "${cred_file}.tmp" "$cred_file"
    else
        touch "$cred_file"
    fi
    echo "https://x-access-token:${token}@github.com" >> "$cred_file"
    chmod 600 "$cred_file"

    info "Git 已配置 → user.name=${GIT_USERNAME}, user.email=${GIT_EMAIL}"
}

clear_git_credential() {
    info "正在清除 git 凭证..."

    local cred_file="$HOME/.git-credentials"
    if [[ -f "$cred_file" ]]; then
        grep -v "github.com" "$cred_file" > "${cred_file}.tmp" 2>/dev/null || true
        mv "${cred_file}.tmp" "$cred_file"
        [[ ! -s "$cred_file" ]] && rm -f "$cred_file"
    fi

    # 不清除 user.name / user.email，用户可能希望保留
    info "Git 凭证已清除（user.name / user.email 保留）"
}

# ── 过期守护进程 ─────────────────────────────────────────────────────────────
expire_guard() {
    local hours="$1"
    local token_id="$2"
    local sleep_sec=$((hours * 3600))

    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] guard started pid=$$ expire_in=${hours}h token_id=${token_id}" >> "$LOG_FILE"

    # 睡眠到期（用循环以便响应信号）
    sleep "$sleep_sec"

    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] guard expired, revoking..." >> "$LOG_FILE"

    # 守护进程是独立 shell，重新加载配置
    if [[ -f "$CONFIG_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$CONFIG_FILE"
    fi

    revoke_token "$token_id"
    clear_git_credential
    clear_state

    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] done. token revoked, git cleared." >> "$LOG_FILE"
}

# ═════════════════════════════════════════════════════════════════════════════
#  命令实现
# ═════════════════════════════════════════════════════════════════════════════

cmd_init() {
    label "╔══════════════════════════════════════════╗"
    label "║   git-temp-auth  初始化配置              ║"
    label "╚══════════════════════════════════════════╝"
    echo ""
    echo "你需要先准备一个【母 token】，它仅用于创建/撤销临时子 token："
    echo ""
    echo "  1. 打开 https://github.com/settings/personal-access-tokens/new"
    echo "  2. Token type 选 Fine-grained"
    echo "  3. Repository access 选 All repositories（或按需）"
    echo "  4. Permissions → Account permissions → Manage personal access tokens → Read and write"
    echo "  5. 过期时间可设较长（如 1 年），因为它权限极小"
    echo "  6. 生成后复制 token 值"
    echo ""
    echo "⚠  母 token 不会配置到 git，仅保存在本地配置文件（权限 600）"
    echo ""

    read -rp "请输入母 token: " master_token
    [[ -z "$master_token" ]] && { error "token 不能为空"; exit 1; }

    read -rp "请输入 git username: " git_username
    [[ -z "$git_username" ]] && { error "username 不能为空"; exit 1; }

    read -rp "请输入 git email: " git_email
    [[ -z "$git_email" ]] && { error "email 不能为空"; exit 1; }

    cat > "$CONFIG_FILE" <<EOF
# git-temp-auth 配置文件（权限 600，请勿泄露）
GITHUB_MASTER_TOKEN="$master_token"
GIT_USERNAME="$git_username"
GIT_EMAIL="$git_email"
EOF
    chmod 600 "$CONFIG_FILE"
    info "配置已保存 → $CONFIG_FILE"

    info "正在验证母 token 有效性..."
    local code
    code=$(verify_master_token "$master_token")
    if [[ "$code" == "200" ]]; then
        info "母 token 验证通过 ✓"
    else
        warn "母 token 验证返回 HTTP $code，请检查 token 是否正确"
        warn "（注意：验证 /user 只确认 token 有效，manage_tokens 权限需在创建时才会校验）"
    fi

    echo ""
    label "初始化完成！常用命令："
    echo "  $0 start --hours 5    创建 5 小时临时授权并配置 git"
    echo "  $0 status             查看当前授权状态"
    echo "  $0 revoke             手动撤销当前授权"
    echo "  $0 help               查看全部命令"
}

cmd_start() {
    local hours=1
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --hours|-h)
                hours="$2"
                if ! [[ "$hours" =~ ^[0-9]+$ ]] || [[ "$hours" -lt 1 ]]; then
                    error "--hours 必须是正整数"
                    exit 1
                fi
                shift 2
                ;;
            *)
                error "未知参数: $1"
                echo "用法: $0 start [--hours N]"
                exit 1
                ;;
        esac
    done

    require_cmd curl
    require_cmd jq
    require_cmd git

    # 检查已有活跃授权
    load_state
    if [[ -n "${TOKEN_ID:-}" ]]; then
        if guard_alive; then
            warn "检测到已有活跃授权 (Token ID: ${TOKEN_ID}, 过期: ${EXPIRES_AT} UTC)"
            read -rp "撤销旧授权并创建新的？(y/N): " confirm
            [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { info "已取消"; exit 0; }
            do_revoke
        else
            warn "发现残留状态但守护进程已退出，正在清理..."
            load_config
            revoke_token "${TOKEN_ID:-}"
            clear_git_credential
            clear_state
        fi
    fi

    load_config

    # 创建临时 token
    local result token_id token expire_iso
    result=$(create_fine_grained_token "$hours")
    token_id=$(echo "$result"    | cut -d'|' -f1)
    token=$(echo "$result"       | cut -d'|' -f2)
    expire_iso=$(echo "$result"  | cut -d'|' -f3)

    # 配置 git
    configure_git "$token"

    # 启动后台守护进程
    nohup bash "$SCRIPT_DIR/git-temp-auth.sh" _guard "$hours" "$token_id" >> "$LOG_FILE" 2>&1 &
    local guard_pid=$!
    disown 2>/dev/null || true

    local expire_epoch
    expire_epoch=$(date_iso_to_epoch "$expire_iso")

    save_state "$token_id" "$token" "$expire_iso" "$expire_epoch" "$guard_pid" "$hours"

    echo ""
    label "╔══════════════════════════════════════════╗"
    label "║   临时授权已启用                         ║"
    label "╚══════════════════════════════════════════╝"
    echo "  Token ID     : $token_id"
    echo "  有效期       : ${hours} 小时"
    echo "  过期时间(UTC): $expire_iso"
    echo "  Git 用户     : $GIT_USERNAME <$GIT_EMAIL>"
    echo "  守护进程     : PID $guard_pid"
    echo ""
    warn "关闭终端不影响守护进程，到期自动撤销"
    warn "提前撤销: $0 revoke"
}

cmd_status() {
    load_state
    if [[ -z "${TOKEN_ID:-}" ]]; then
        info "当前没有活跃的临时授权"
        return
    fi

    label "╔══════════════════════════════════════════╗"
    label "║   当前临时授权状态                       ║"
    label "╚══════════════════════════════════════════╝"
    echo "  Token ID     : $TOKEN_ID"
    echo "  创建时间(UTC): ${CREATED_AT:-未知}"
    echo "  过期时间(UTC): $EXPIRES_AT"
    echo "  守护进程 PID : ${GUARD_PID:-未知}"

    if guard_alive; then
        echo "  状态         : ${GREEN}运行中${NC}"
        if [[ -n "${EXPIRE_EPOCH:-}" ]]; then
            local now remaining
            now=$(date +%s)
            remaining=$((EXPIRE_EPOCH - now))
            if [[ $remaining -gt 0 ]]; then
                printf "  剩余时间     : %d 小时 %d 分钟\n" $((remaining / 3600)) $(( (remaining % 3600) / 60 ))
            else
                echo "  剩余时间     : ${RED}已过期${NC}"
            fi
        fi
    else
        echo "  状态         : ${YELLOW}守护进程已退出（可能已过期或被终止）${NC}"
    fi
}

do_revoke() {
    load_state
    if [[ -z "${TOKEN_ID:-}" ]]; then
        info "当前没有活跃的临时授权"
        return
    fi

    load_config

    if guard_alive; then
        kill "$GUARD_PID" 2>/dev/null || true
        info "守护进程已终止"
    fi

    revoke_token "$TOKEN_ID"
    clear_git_credential
    clear_state

    info "临时授权已完全撤销 ✓"
}

cmd_revoke() { do_revoke; }

cmd_guard() {
    local hours="${1:?}" token_id="${2:?}"
    expire_guard "$hours" "$token_id"
}

cmd_help() {
    cat <<'EOF'
git-temp-auth — 临时 GitHub 身份配置工具

用法:
  git-temp-auth.sh <命令> [选项]

命令:
  init              初始化配置（母 token、username、email）
  start --hours N   创建 N 小时临时授权并配置 git（默认 1 小时）
  status            查看当前授权状态与剩余时间
  revoke            手动撤销当前临时授权（删 token + 清 git 凭证）
  help              显示此帮助

示例:
  ./git-temp-auth.sh init                  # 首次使用，配置母 token
  ./git-temp-auth.sh start --hours 5       # 授权 5 小时
  ./git-temp-auth.sh start --hours 1       # 授权 1 小时
  ./git-temp-auth.sh status                # 查看状态
  ./git-temp-auth.sh revoke                # 提前撤销

工作原理:
  1. 用母 token（仅 manage_tokens 权限）调用 GitHub API 创建短期 fine-grained PAT
  2. 将子 token 写入 git credential helper（store）
  3. 后台 nohup 守护进程睡眠 N 小时后自动：撤销子 token + 清除 git 凭证
  4. 母 token 不配置到 git，权限极小，泄露风险可控
EOF
}

# ═════════════════════════════════════════════════════════════════════════════
#  主入口
# ═════════════════════════════════════════════════════════════════════════════
case "${1:-help}" in
    init)    cmd_init ;;
    start)   shift; cmd_start "$@" ;;
    status)  cmd_status ;;
    revoke)  cmd_revoke ;;
    _guard)  shift; cmd_guard "$@" ;;
    help|--help|-h) cmd_help ;;
    *)
        error "未知命令: $1"
        echo "运行 $0 help 查看用法"
        exit 1
        ;;
esac
