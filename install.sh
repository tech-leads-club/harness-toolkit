#!/usr/bin/env bash
# Install runtime at ~/.tlc/harness
set -euo pipefail

REPO_URL="${TLC_REPO_URL:-https://github.com/tech-leads-club/harness-toolkit.git}"
DEST="${TLC_HOME:-$HOME/.tlc/harness}"
BIN_DIR="${TLC_BIN_DIR:-$HOME/.local/bin}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "install: missing dependency: $1" >&2
    exit 1
  }
}

need git
need node

node_major="$(node -p "process.versions.node.split('.')[0]")"
# Bun runs every hook directly, so it satisfies the runtime requirement on its own. Only a machine with
# neither Bun nor Node 24+ has no way to run a hook.
if [[ "$node_major" -lt 24 ]] && ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOF
install: no supported hook runtime found (Node $(node -v), and Bun is not installed).

  Pick either one:
    Bun     curl -fsSL https://bun.sh/install | bash     (recommended; ~1 ms per hook)
    Node    install 24 LTS or 26 from https://nodejs.org/ (~27 ms per hook)

  Then re-run this installer.
EOF
  exit 1
fi

# hazard: piped through `curl … | bash` the script has no file on disk, so BASH_SOURCE is an empty array and
# `set -u` aborts on reading it — which is the documented install command in the README. An absent source is
# not an error, it means there is no local checkout to link, so the clone path below is the right answer.
# install.ps1 already guards the same way with `if ($scriptRoot -and …)`.
script_source="${BASH_SOURCE[0]:-}"
script_root=""
if [[ -n "$script_source" ]]; then
  script_root="$(cd "$(dirname "$script_source")" && pwd)"
fi
if [[ -n "$script_root" && -f "$script_root/bin/tlc-exec.mjs" && "$script_root" != "$DEST" ]]; then
  echo "install: linking $DEST → $script_root"
  mkdir -p "$(dirname "$DEST")" "$BIN_DIR"
  ln -sfn "$script_root" "$DEST"
elif [[ -L "$DEST" ]]; then
  # invariant: a symlinked runtime points at somebody's working clone, so no git command runs against it — the
  # same ownership rule the CLI applies (AD-046). The link is left exactly as it is.
  echo "install: $DEST is a link to $(readlink "$DEST") — leaving that clone untouched"
else
  mkdir -p "$(dirname "$DEST")" "$BIN_DIR"
  if [[ -d "$DEST/.git" ]]; then
    # why: a hard reset, not `pull --ff-only`. The runtime path is an artifact this installer created, so a local
    # change in it is never the operator's work. `pull --ff-only` aborted whenever a previous build had rewritten
    # dist/ with a different bundler, and this is the one recovery route that does not depend on the installed CLI
    # — which is exactly what a broken updater cannot deliver ([/decisions/ad-048.md](/decisions/ad-048.md)).
    #
    # invariant: untracked files survive a hard reset, and config.json plus state/ are gitignored. Nothing the
    # operator owns is inside what this discards.
    echo "install: moving the runtime at $DEST to origin/main"
    git -C "$DEST" fetch origin
    git -C "$DEST" reset --hard origin/main
  elif [[ -e "$DEST" ]]; then
    echo "install: $DEST exists and is not a git checkout — move it aside and re-run." >&2
    exit 1
  else
    # why: while the repository is private, an unauthenticated clone fails with git's own credential error, which
    # says nothing about org membership. A refusal names the route that works ([/decisions/ad-047.md](/decisions/ad-047.md)).
    if ! git clone "$REPO_URL" "$DEST"; then
      echo "install: could not clone $REPO_URL" >&2
      echo "  While the repository is private this needs a GitHub credential: install the gh CLI and run" >&2
      echo "  \`gh auth login\` then \`gh auth setup-git\`, and confirm you are in the tech-leads-club org." >&2
      exit 1
    fi
  fi
fi

if [[ ! -f "$DEST/config.json" && -f "$DEST/config.example.json" ]]; then
  cp "$DEST/config.example.json" "$DEST/config.json"
fi

ln -sfn "$DEST/bin/tlc" "$BIN_DIR/tlc"
chmod +x "$DEST/bin/tlc" "$DEST/bin/tlc-exec" "$DEST/bin/tlc-build" "$DEST/install.sh" || true

skills_src="$DEST/skills/harness-init"
if [[ ! -d "$skills_src" ]]; then
  echo "install: missing $skills_src" >&2
  exit 1
fi

# Each provider only reads its own skills directory, so link into the ones that exist.
# The config dir is resolved, never assumed: both tools relocate it via env.
cursor_dir="${CURSOR_CONFIG_DIR:-$HOME/.cursor}"
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
linked_any=0
for provider_dir in "$cursor_dir" "$claude_dir"; do
  [[ -d "$provider_dir" ]] || continue
  mkdir -p "$provider_dir/skills"
  ln -sfn "$skills_src" "$provider_dir/skills/harness-init"
  echo "install: skill → $provider_dir/skills/harness-init"
  linked_any=1
done
if [[ "$linked_any" -eq 0 ]]; then
  echo "install: no provider config dir found — skill not linked (install Cursor or Claude Code first)" >&2
fi

export TLC_HOME="$DEST"
node "$DEST/bin/write-user-hooks.mjs" || {
  echo "install: hooks not written (existing file without harness). Merge manually or: node \"$DEST/bin/write-user-hooks.mjs\" --force" >&2
}

if ! command -v tlc >/dev/null 2>&1; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "install: add $BIN_DIR to PATH, then reopen the shell." >&2 ;;
  esac
fi

echo "install: ok → $DEST"
if command -v tlc >/dev/null 2>&1; then
  tlc harness doctor || true
elif [[ -x "$BIN_DIR/tlc" ]]; then
  "$BIN_DIR/tlc" harness doctor || true
fi
