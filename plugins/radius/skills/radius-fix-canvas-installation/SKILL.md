---
name: radius-fix-canvas-installation
description: 'Workaround for a GitHub Copilot App bug where an installed plugin''s canvas is not loaded even though its skills are. Copies the Radius plugin''s canvas extension files (extension.mjs, package.json) from the installed-plugins folder into the extensions folder so the Radius Canvas registers. USE FOR: "fix radius canvas", "radius canvas not showing", "radius canvas won''t open", "install radius canvas", "the radius plugin canvas is missing", "reinstall radius extension". DO NOT USE FOR: any plugin other than radius, authoring or editing canvas code, or general plugin/skill installation.'
---

# Fix Radius Canvas Installation

## Purpose

Repair a broken **Radius Canvas** registration in the GitHub Copilot App.

This is a **workaround for a GitHub Copilot App bug**: when a user installs a plugin that contains a canvas, the plugin lands in `~/.copilot/installed-plugins/<marketplace>/<plugin>` and its **skills** load correctly, but the **canvas is not discovered/loaded** from that location. The fix is to copy the canvas extension files into `~/.copilot/extensions/` where the canvas loader does find them.

This skill applies **only to the `radius` plugin** from the `radius-plugins` marketplace. Run it after installing or updating the Radius plugin if the Radius Canvas does not appear. It is a temporary workaround and can be removed once GitHub fixes the underlying canvas-discovery bug.

## When to use

Use when the Radius Canvas will not open or is missing even though the Radius plugin/skills are installed and working. Typical triggers: "fix radius canvas", "radius canvas not showing", "reinstall radius extension".

Do **not** use for any other plugin, or for editing canvas source code.

## Paths

- Source: `~/.copilot/installed-plugins/radius-plugins/radius/`
- Destination: `~/.copilot/extensions/radius/`

Files to copy:

- `extension.mjs`
- `package.json`

The `~/.copilot` directory is under the user's home directory on every platform:

- **macOS / Linux:** `$HOME/.copilot` (e.g. `/Users/<you>/.copilot`)
- **Windows:** `%USERPROFILE%\.copilot` (e.g. `C:\Users\<you>\.copilot`), which PowerShell exposes as `$HOME`

## Procedure

Pick the code block matching the host OS. Run the shell commands directly; do not hardcode a username — always resolve the home directory dynamically.

1. **Resolve the home directory.** Use `$HOME` in both PowerShell and bash. Build the source and destination folder paths from it.

2. **Verify the source exists.** Confirm the source folder and both source files (`extension.mjs`, `package.json`) are present.
   - If the source folder does not exist, stop and tell the user the Radius plugin is not installed under `radius-plugins/radius`; there is nothing to copy. Do not attempt to download or synthesize the files.

3. **Ensure the destination folder exists.** Create `~/.copilot/extensions/radius/` if it is missing.

4. **Copy both files**, overwriting any existing copies in the destination:
   - `.../installed-plugins/radius-plugins/radius/extension.mjs` -> `.../extensions/radius/extension.mjs`
   - `.../installed-plugins/radius-plugins/radius/package.json` -> `.../extensions/radius/package.json`

5. **Verify the copy.** Confirm both files now exist in the destination and are non-empty. Optionally compare byte length or hash against the source to confirm an exact copy.

6. **Tell the user to reload.** The canvas is discovered at extension-load time, so instruct the user to reload extensions or restart the GitHub Copilot App for the Radius Canvas to appear.

### PowerShell (Windows)

```powershell
$src   = Join-Path $HOME '.copilot\installed-plugins\radius-plugins\radius'
$dst   = Join-Path $HOME '.copilot\extensions\radius'
$files = 'extension.mjs','package.json'

if (-not (Test-Path $src)) { throw "Radius plugin not found at $src" }

# Verify both source files exist before copying anything.
foreach ($f in $files) {
    $sp = Join-Path $src $f
    if (-not (Test-Path $sp)) { throw "Missing source file: $sp" }
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null

foreach ($f in $files) {
    Copy-Item -Path (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force
}

# Verify each destination file now exists and is non-empty.
foreach ($f in $files) {
    $dp = Join-Path $dst $f
    if (-not (Test-Path $dp) -or (Get-Item $dp).Length -eq 0) {
        throw "Copy failed or produced an empty file: $dp"
    }
}

Get-ChildItem $dst | Select-Object Name, Length
```

### bash / zsh (macOS / Linux)

```bash
set -euo pipefail

src="$HOME/.copilot/installed-plugins/radius-plugins/radius"
dst="$HOME/.copilot/extensions/radius"
files=(extension.mjs package.json)

[ -d "$src" ] || { echo "Radius plugin not found at $src" >&2; exit 1; }

# Verify both source files exist before copying anything.
for f in "${files[@]}"; do
  [ -f "$src/$f" ] || { echo "Missing source file: $src/$f" >&2; exit 1; }
done

mkdir -p "$dst"

for f in "${files[@]}"; do
  cp -f "$src/$f" "$dst/$f"
done

# Verify each destination file now exists and is non-empty.
for f in "${files[@]}"; do
  [ -s "$dst/$f" ] || { echo "Copy failed or produced an empty file: $dst/$f" >&2; exit 1; }
done

ls -l "$dst"
```

## Completion checklist

- Source folder and both source files existed (or the user was clearly told the plugin is not installed and the skill stopped).
- `~/.copilot/extensions/radius/` exists.
- `extension.mjs` and `package.json` are present and non-empty in the destination.
- The user was told to reload extensions / restart the app.

## Constraints and pitfalls

- Only ever touch the `radius` plugin and the `radius` extension folder. Do not copy `skills/`, `plugin.json`, `README.md`, or any other files.
- Always overwrite the destination files so a re-run picks up plugin updates.
- Never fabricate `extension.mjs` or `package.json` if the source is missing; the correct recovery is to (re)install the Radius plugin first.
- This is a temporary workaround. If a future GitHub Copilot App version loads plugin canvases directly from `installed-plugins`, this skill is no longer needed.
