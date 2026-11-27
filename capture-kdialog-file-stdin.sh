#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  ubuntu)
    export DEBIAN_FRONTEND=noninteractive
    apt-get -qq update
    apt-get -qq install -y --no-install-recommends kdialog xvfb imagemagick xdotool fonts-dejavu-core
    ;;
  fedora)
    dnf -q -y --setopt=install_weak_deps=False install kdialog xorg-x11-server-Xvfb ImageMagick xdotool dejavu-sans-fonts
    ;;
  *) exit 2 ;;
esac

mkdir -p /out
export HOME=/tmp/kdialog-test-home XDG_RUNTIME_DIR=/tmp/kdialog-test-runtime QT_QPA_PLATFORM=xcb
mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR"
export DISPLAY=:87
Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp >/out/xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
for attempt in {1..100}; do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.1
done

source /etc/os-release
{
  printf 'Distro: %s\n' "$PRETTY_NAME"
  if [ "$1" = ubuntu ]; then
    dpkg-query -W kdialog
  else
    rpm -q kdialog
  fi
  uname -m
  kdialog --version
} | tee /out/versions.txt

# This is the same HTML encoding the reviewed DisplayService sends to stdin.
printf '%s\n' '<pre>Verify KDialog stdin<br><br>Tool: Bash<br>Scope: single<br><br>Input: printf &lt;draft&gt; &amp; final<br>Indent:    alpha    beta<br><br>End of review: KDE-STDIN-3353</pre>' >/out/review-input.html
timeout 45s kdialog --title 'KDialog stdin runtime proof' --textbox - 720 420 </out/review-input.html >/out/review.stdout 2>/out/review.stderr &
review_pid=$!
review_window=$(timeout 25s xdotool search --sync --onlyvisible --name '^KDialog stdin runtime proof$' | sed -n '1p')
import -silent -window "$review_window" -strip /out/review.png
xdotool windowfocus --sync "$review_window" key Return
wait "$review_pid"

timeout 45s kdialog --title 'DollhouseMCP approval' --radiolist 'Apply the reviewed action?' \
  cancel Cancel on approve Approve off >/out/selection.txt 2>/out/selection.stderr &
selection_pid=$!
selection_window=$(timeout 25s xdotool search --sync --onlyvisible --name '^DollhouseMCP approval$' | sed -n '1p')
import -silent -window "$selection_window" -strip /out/cancel-default.png
xdotool windowfocus --sync "$selection_window" key Return
wait "$selection_pid"
test "$(cat /out/selection.txt)" = cancel
printf 'Enter on the default selection returned: %s\n' "$(cat /out/selection.txt)"
