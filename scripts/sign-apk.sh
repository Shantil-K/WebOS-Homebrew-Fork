#!/bin/sh
# Aligns and signs the release APK with your own key, then optionally installs it over adb.
# Key: ~/.android-keys/webos-homebrew-fork.jks, password in webos-homebrew-fork.properties next to it (never in the repo).
# Usage: scripts/sign-apk.sh [adb-device-serial]
set -e
BT="${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools/$(ls "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" | sort -V | tail -1)"
K="$HOME/.android-keys"
P=$(grep '^store=' "$K/webos-homebrew-fork.properties" | cut -d= -f2-)
IN=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
OUT=webos-homebrew-fork-arm64.apk
TMP=$(mktemp --suffix=.apk)
"$BT/zipalign" -f -p 4 "$IN" "$TMP"
"$BT/apksigner" sign --ks "$K/webos-homebrew-fork.jks" --ks-key-alias webos-homebrew-fork \
  --ks-pass "pass:$P" --key-pass "pass:$P" --out "$OUT" "$TMP"
rm -f "$TMP"
"$BT/apksigner" verify "$OUT" && echo "signed $OUT"
[ -n "$1" ] && adb -s "$1" install -r "$OUT"
