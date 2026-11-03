# WebOS Homebrew Fork

A fork of [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) by the webOS Homebrew Team, with an **Updates** tab for keeping homebrew apps on an LG webOS TV up to date from their release links.

- **Add apps by link:** paste an app's GitHub, GitLab or Codeberg/Gitea/Forgejo repository. The app reads the package's app ID from its newest release.
- **Update all:** one button installs every newer release, using Dev Manager's own installer (Homebrew Channel on rooted TVs, developer mode otherwise).
- **Works with the TV off:** the list is kept in the app (one list per TV), so you can add apps any time; versions and installs come back when the TV is on.
- **Everything else** is Dev Manager as before: device setup (developer mode, or root SSH with a key or password), apps, files and terminal.

Changes from upstream: the Updates tab (`src/app/updates/`), the app's name and ID (`io.github.shantilk.weboshomebrewfork`, so it installs next to the official app), the update check and links pointing at this repo, crash reporting switched off (upstream's Sentry project), and a release workflow that builds every platform on a version tag. `scripts/sign-apk.sh` signs a local Android build.

## Releases

Pushing a tag like `v1.0.0` builds and publishes Windows (`.msi`, x64 and x86), Linux (`.deb`, `.rpm` and `.AppImage`, amd64 and arm64), macOS (universal `.dmg`) and Android (universal `.apk`, signed with the repository's key). The Android build needs these repository secrets: `ANDROID_SIGNING_STORE_DATA` (the keystore, base64), `ANDROID_SIGNING_STORE_PASSWORD`, `ANDROID_SIGNING_KEY_ALIAS` and `ANDROID_SIGNING_KEY_PASSWORD`.

Licensed under the Apache License 2.0, like the original. The original README follows.

---

# Device/DevMode Manager for webOS TV

Simple tool to manage developer mode enabled or rooted webOS
TV

## Download

Find [latest release](https://github.com/webosbrew/dev-manager-desktop/releases/latest), and download the installer for
your system

| Operating System                  | x86_64                                      | arm64                                         | x86                                       |
|-----------------------------------|---------------------------------------------|-----------------------------------------------|-------------------------------------------|
| Windows 10+                       | webOS.Dev.Manager_[VERSION]_x64_en-US.msi   | Not available                                 | webOS.Dev.Manager_[VERSION]_x86_en-US.msi |
| Windows 7/8/8.1 (Dropped support) | webOS.Dev.Manager_1.13.3_x64_en-US.msi      | Not available                                 | webOS.Dev.Manager_1.13.3_x86_en-US.msi    |
| macOS                             | webOS.Dev.Manager_[VERSION]_universal.dmg   | webOS.Dev.Manager_[VERSION]_universal.dmg     | Not available                             |
| Linux (Debian/Ubuntu)             | webos-dev-manager_[VERSION]_amd64.deb       | webos-dev-manager_[VERSION]_arm64.deb         | Not available                             |
| Linux (Other distros)             | webos-dev-manager_[VERSION]_amd64.AppImage  | webos-dev-manager_[VERSION]_aarch64.AppImage  | Not available                             |

### AppImage updates

Official AppImage builds include update metadata for tools such as
[AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate).
Download the AppImage for your architecture; the matching `.AppImage.zsync`
file is published alongside it for update tools. Stable releases and workflow
snapshots track the latest stable release; prerelease builds track the
latest prerelease. Updates keep the same architecture. Older AppImages without
this metadata need a manual download first.

### Scheduled Developer Mode renewal

The generated renewal shell script requires `curl`, `jq`, and OpenSSH (`ssh`
and `ssh-keygen`) on the machine that runs it. Install these with its package
manager before scheduling the script (including on OpenWrt). The script uses
a persistent token cache when the TV is unreachable and exits with an error
if the request fails or the server does not report success.

## Features

- No need to install LG SDK or IDE
- Add device without need to use command line
- Install apps on TV with a few clicks
- Configuration compatible with [ares-cli](https://github.com/webosose/ares-cli)
- Works on Windows, Linux and macOS (Apple Silicon too!)
- Dark mode follows system preferences

![Add Device](https://user-images.githubusercontent.com/830358/215522596-196d9629-3942-4533-bebb-5a81ba62ebc0.png)

![Installed Apps](https://user-images.githubusercontent.com/830358/215522298-eadebc84-661b-40ad-b6a9-9379710f88dc.png)

![Install from webOS Homebrew repo](https://user-images.githubusercontent.com/830358/215523117-0fdbde24-a503-4eed-8e2f-50a3486ce7f7.png)

![Manage Files](https://user-images.githubusercontent.com/830358/215522354-50997437-e3de-43a9-89cc-52cdaecb0502.png)

![Built-in Terminal](https://user-images.githubusercontent.com/830358/215522468-bc3e4871-01b2-4eed-a8b2-31f683874ba1.png)

![Device Information](https://user-images.githubusercontent.com/830358/215522554-5554a89b-ff3e-455e-8ed7-0f28c03f04a9.png)
