#!/bin/sh
# install.sh — установка Swarm на macOS одной командой.
#
# Зачем отдельный установщик, когда есть dmg. Карантин («не удалось проверить
# разработчика») вешает на файл не система сама по себе, а приложение, которое его
# скачало: браузеры и почта помечают загрузки, curl — нет. Поэтому приложение, принесённое
# этим скриптом, запускается сразу, без обхода Gatekeeper и без команд в терминале после.
# Заверение у Apple (и платная подписка разработчика) нужны ровно для того же самого — и
# только для случая, когда dmg скачали браузером.
#
# Целостность образа проверяет сам hdiutil: в dmg есть контрольная сумма, и с битым
# файлом он просто не смонтируется.
#
# Запуск:
#   curl -fsSL https://raw.githubusercontent.com/raul-cortez/claude-swarm/main/scripts/install.sh | sh
#
# Куда ставит: /Программы, если туда можно писать, иначе ~/Applications. Переопределяется
# переменной SWARM_DEST (этим же пользуются проверки).
set -eu

REPO=raul-cortez/claude-swarm
MANIFEST="https://github.com/$REPO/releases/latest/download/manifest.json"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
step() { printf '▸ %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || die "это установщик для macOS; для Windows есть .exe в релизах"
[ "$(uname -m)" = "arm64" ] || die "сборки есть только для Apple Silicon (у вас $(uname -m))"

DEST="${SWARM_DEST:-}"
if [ -z "$DEST" ]; then
  if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; fi
fi
mkdir -p "$DEST"

# Подменять файлы работающего приложения нельзя: оно живёт в них прямо сейчас.
if pgrep -x Swarm >/dev/null 2>&1; then
  die "Swarm сейчас запущен — закройте его и повторите"
fi

step "узнаю последнюю версию"
manifest=$(curl -fsSL "$MANIFEST") || die "не скачался манифест — проверьте связь"
url=$(printf '%s\n' "$manifest" | sed -n 's/.*"dmg"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
ver=$(printf '%s\n' "$manifest" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$url" ] || die "в манифесте нет ссылки на образ"

mnt=""
tmp=$(mktemp -d)
cleanup() {
  [ -n "$mnt" ] && hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

step "качаю Swarm ${ver:-}"
# Полоска прогресса — только когда есть кому смотреть: в перенаправленный вывод она
# высыпается тысячей строк (так и обнаружилось).
if [ -t 1 ]; then
  curl -fL# -o "$tmp/swarm.dmg" "$url" || die "не скачался образ"
else
  curl -fsSL -o "$tmp/swarm.dmg" "$url" || die "не скачался образ"
fi

step "распаковываю"
mnt=$(hdiutil attach -nobrowse -readonly "$tmp/swarm.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
[ -n "$mnt" ] || die "образ не смонтировался (возможно, скачался битым — повторите)"
app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)
[ -n "$app" ] || die "в образе нет приложения"
name=$(basename "$app")

step "ставлю в $DEST"
rm -rf "$DEST/$name"
# ditto, а не cp: сохраняет подпись и права внутри бандла как есть.
ditto "$app" "$DEST/$name"
# На всякий случай: если папку назначения когда-то пометили карантином, снимаем.
xattr -dr com.apple.quarantine "$DEST/$name" >/dev/null 2>&1 || true

printf '\n✔ Готово: %s/%s\n' "$DEST" "$name"
printf '  Открыть: open "%s/%s"\n' "$DEST" "$name"
printf '  Нужен установленный Claude Code — проверьте командой: claude --version\n'
