#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="https://github.com/postEntropy/milo.git"
DEFAULT_BRANCH="main"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

REPO_URL="${MILO_REPO_URL:-$DEFAULT_REPO}"
BRANCH="${MILO_BRANCH:-$DEFAULT_BRANCH}"

if [[ "$(id -u)" -eq 0 ]]; then
  INSTALL_DIR="${MILO_INSTALL_DIR:-/opt/milo}"
  BIN_DIR="${MILO_BIN_DIR:-/usr/local/bin}"
else
  INSTALL_DIR="${MILO_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/milo}"
  BIN_DIR="${MILO_BIN_DIR:-$HOME/.local/bin}"
fi

usage() {
  cat <<'EOF'
Milo installer (clones or updates from GitHub and builds CLI + Web UI)

Usage:
  curl -fsSL https://raw.githubusercontent.com/postEntropy/milo/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/postEntropy/milo/main/install.sh | bash -s -- [options]

Options:
  --dir <path>      Install directory (default: ~/.local/share/milo, or /opt/milo as root)
  --bin-dir <path>  Executable directory (default: ~/.local/bin, or /usr/local/bin as root)
  --branch <ref>    Git branch to install/update (default: main)
  --repo <url>      Git repository URL (default: https://github.com/postEntropy/milo.git)
  -h, --help        Show this help

Environment variables:
  MILO_INSTALL_DIR, MILO_BIN_DIR, MILO_BRANCH, MILO_REPO_URL
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -ge 2 ]] || { echo "Error: --dir requires a value." >&2; exit 1; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir)
      [[ $# -ge 2 ]] || { echo "Error: --bin-dir requires a value." >&2; exit 1; }
      BIN_DIR="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || { echo "Error: --branch requires a value." >&2; exit 1; }
      BRANCH="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Error: --repo requires a value." >&2; exit 1; }
      REPO_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but was not found on PATH." >&2
    exit 1
  fi
}

check_node_version() {
  local raw major minor
  raw="$(node -p "process.versions.node")"
  major="${raw%%.*}"
  minor="${raw#*.}"
  minor="${minor%%.*}"
  if (( major < MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor < MIN_NODE_MINOR) )); then
    echo "Error: Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 is required (found ${raw})." >&2
    echo "Milo requires node:sqlite, which is built into Node.js 22.13+ and 24+." >&2
    exit 1
  fi
}

write_wrapper() {
  local name="$1"
  local target="$2"
  local node_bin="$3"
  local dest="${BIN_DIR}/${name}"
  cat >"$dest" <<EOF
#!/usr/bin/env sh
set -eu
if [ -x "${node_bin}" ]; then
  exec "${node_bin}" "${target}" "\$@"
fi
exec node "${target}" "\$@"
EOF
  chmod 0755 "$dest"
}

require_cmd git
require_cmd node
require_cmd npm
check_node_version

NODE_BIN="$(command -v node)"
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "Updating Milo in ${INSTALL_DIR} (branch: ${BRANCH})..."
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    echo "Error: ${INSTALL_DIR} has uncommitted local changes. Commit or stash them first." >&2
    exit 1
  fi
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --tags
  if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git -C "$INSTALL_DIR" checkout "$BRANCH"
  else
    git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/${BRANCH}"
  fi
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
  echo "Error: ${INSTALL_DIR} exists and is not a git repository." >&2
  exit 1
else
  echo "Cloning Milo (${BRANCH}) into ${INSTALL_DIR}..."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

echo "Installing dependencies and building Milo..."
# Keep devDependencies even if NODE_ENV=production is set in the shell.
export NODE_ENV=development
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  npm --prefix "$INSTALL_DIR" ci --include=dev
else
  npm --prefix "$INSTALL_DIR" install --include=dev
fi
npm --prefix "$INSTALL_DIR" run build

echo "Building Web UI..."
if [[ -f "${INSTALL_DIR}/web/package-lock.json" ]]; then
  npm --prefix "${INSTALL_DIR}/web" ci --include=dev
else
  npm --prefix "${INSTALL_DIR}/web" install --include=dev
fi
npm --prefix "${INSTALL_DIR}/web" run build

write_wrapper "milo" "${INSTALL_DIR}/dist/bin/cli.js" "$NODE_BIN"
write_wrapper "milo-web" "${INSTALL_DIR}/dist/bin/web.js" "$NODE_BIN"

VERSION_STR="$("${BIN_DIR}/milo" --version)"
echo ""
echo "Installed Milo ${VERSION_STR}"
echo "  Source:  ${INSTALL_DIR}"
echo "  Command: ${BIN_DIR}/milo"
echo "  Web UI:  ${BIN_DIR}/milo-web"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "Add ${BIN_DIR} to your PATH:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Next steps:"
echo "  milo setup                 # configure provider, API key, and gateways"
echo "  milo serve                 # run bot gateways and web UI"
echo "  milo update                # pull new commits from GitHub and rebuild"
echo "  milo export / milo import  # back up or migrate ~/.milo"
