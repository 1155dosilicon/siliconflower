#!/usr/bin/env bash
# Installs the Siliconflower desktop app (AppImage) for the current user only, without root:
#   app      -> ~/.local/share/siliconflower-desktop/app   (the AppImage, extracted)
#   command  -> ~/.local/bin/siliconflower-desktop
#   menu     -> ~/.local/share/applications/siliconflower-desktop.desktop
#   icon     -> ~/.local/share/icons/hicolor/256x256/apps/siliconflower-desktop.png
#
# The AppImage is extracted instead of run, so FUSE is not needed. Never `apt install fuse`
# on Ubuntu 24.04 / elementary OS 8: it removes fuse3 and part of the desktop.
#
# Usage:
#   bash scripts/install-appimage.sh [Siliconflower-<version>-x86_64.AppImage]
#   bash scripts/install-appimage.sh --uninstall
# Without a path, uses the newest dist-desktop/Siliconflower-*.AppImage or one in the current folder.
# Your settings, conversations and recent projects (~/.siliconflower, ~/.config/Siliconflower)
# are never touched, not even by --uninstall.
set -euo pipefail

WORK=""

NAME="siliconflower-desktop"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="${SILICONFLOWER_INSTALL_DIR:-$HOME/.local/bin}"
APP_HOME="$DATA_HOME/$NAME"
APP_DIR="$APP_HOME/app"
LAUNCHER="$BIN_DIR/$NAME"
DESKTOP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$DESKTOP_DIR/$NAME.desktop"
ICON_ROOT="$DATA_HOME/icons/hicolor"
ICON_FILE="$ICON_ROOT/256x256/apps/$NAME.png"

say() { printf '%s\n' "$*"; }
fail() { printf 'Erro: %s\n' "$*" >&2; exit 1; }

refresh_menus() {
  # Optional helpers: the menu also picks the entry up on its own after a while.
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d "$ICON_ROOT" ]; then
    gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true
  fi
}

uninstall() {
  rm -rf "$APP_HOME"
  rm -f "$LAUNCHER" "$DESKTOP_FILE" "$ICON_FILE"
  refresh_menus
  say "Siliconflower removido. Configuração e conversas (~/.siliconflower) foram mantidas."
}

find_appimage() {
  local candidates=()
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  shopt -s nullglob
  candidates=("$script_dir"/../dist-desktop/Siliconflower-*.AppImage ./Siliconflower-*.AppImage)
  shopt -u nullglob
  [ "${#candidates[@]}" -gt 0 ] || return 1
  # Newest first.
  ls -t "${candidates[@]}" | head -n 1
}

# True when unprivileged programs cannot create user namespaces, which the Chromium sandbox
# needs when chrome-sandbox is not setuid root (it never is in a user install). Same probe as
# the AppImage's own AppRun, plus the kernel switches it may not catch.
sandbox_blocked() {
  local f
  if command -v unshare >/dev/null 2>&1 && ! unshare -Ur true >/dev/null 2>&1; then
    return 0
  fi
  f=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  [ -r "$f" ] && [ "$(cat "$f")" = "1" ] && return 0
  f=/proc/sys/kernel/unprivileged_userns_clone
  [ -r "$f" ] && [ "$(cat "$f")" = "0" ] && return 0
  return 1
}

install() {
  local appimage="${1:-}"
  if [ -z "$appimage" ]; then
    appimage="$(find_appimage)" || fail "nenhum Siliconflower-*.AppImage encontrado. Passe o caminho: bash $0 <arquivo.AppImage>"
  fi
  [ -f "$appimage" ] || fail "arquivo não encontrado: $appimage"
  appimage="$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")"
  say "Instalando $appimage"

  mkdir -p "$APP_HOME" "$BIN_DIR" "$DESKTOP_DIR" "$(dirname "$ICON_FILE")"
  WORK="$(mktemp -d "$APP_HOME/.install.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT

  chmod +x "$appimage" 2>/dev/null || true
  # --appimage-extract is handled by the AppImage runtime itself: no FUSE involved.
  (cd "$WORK" && "$appimage" --appimage-extract >/dev/null) || fail "não consegui extrair o AppImage"
  [ -x "$WORK/squashfs-root/$NAME" ] || fail "o AppImage não contém $NAME: é mesmo o Siliconflower?"

  # Replace the old version only once the new one is fully extracted.
  rm -rf "$APP_DIR.old"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
  mv "$WORK/squashfs-root" "$APP_DIR"
  rm -rf "$APP_DIR.old"

  local flags=""
  if sandbox_blocked; then
    flags=" --no-sandbox"
    say "Aviso: este sistema bloqueia o sandbox do Chromium para apps instalados sem root (AppArmor)."
    say "       O app vai rodar com --no-sandbox. Para manter o sandbox, instale o pacote .deb."
  fi

  cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$APP_DIR/$NAME"$flags "\$@"
EOF
  chmod +x "$LAUNCHER"

  local icon_src="$APP_DIR/usr/share/icons/hicolor/256x256/apps/$NAME.png"
  [ -f "$icon_src" ] || icon_src="$APP_DIR/$NAME.png"
  if [ -f "$icon_src" ]; then cp "$icon_src" "$ICON_FILE"; fi

  local version
  version="$(sed -n 's/^X-AppImage-Version=//p' "$APP_DIR/$NAME.desktop" 2>/dev/null | head -n 1)"
  # The file name and StartupWMClass match the window (desktopName in desktop/package.json),
  # so the dock shows this icon for the open app.
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Siliconflower
Comment=Agente de IA para desenvolvimento de software
Exec="$LAUNCHER" %F
Icon=$NAME
Terminal=false
Categories=Development;
StartupWMClass=$NAME
X-Siliconflower-Version=${version:-desconhecida}
EOF
  chmod +x "$DESKTOP_FILE"
  refresh_menus

  say "Pronto: Siliconflower ${version:-} instalado."
  say "  Menu de aplicativos: procure por \"Siliconflower\""
  say "  Terminal: $NAME"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "  Aviso: $BIN_DIR não está no PATH; o comando $NAME só funciona pelo caminho completo (o menu funciona)." ;;
  esac
  say "Para remover: bash $0 --uninstall"
}

case "${1:-}" in
  --uninstall|-u) uninstall ;;
  --help|-h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) install "${1:-}" ;;
esac
