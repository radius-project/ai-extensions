---
name: radius-fix-canvas-installation
description: 'Workaround for a GitHub Copilot App bug where an installed plugin''s canvas is not loaded even though its skills are. Copies the Radius plugin''s canvas extension files and bundled workflows from the installed-plugins folder into the extensions folder so the Radius Canvas registers and uses matching workflow assets. USE FOR: "fix radius canvas", "radius canvas not showing", "radius canvas won''t open", "install radius canvas", "the radius plugin canvas is missing", "reinstall radius extension". DO NOT USE FOR: any plugin other than radius, authoring or editing canvas code, or general plugin/skill installation.'
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
- `workflows/` — **required**; replace the complete destination tree so its templates and actions come from the same plugin build as `extension.mjs`
- `extension.mjs.map` — **optional**; only present on newer installs. Copy it when it exists, but never fail the repair if it is missing.

The `~/.copilot` directory is under the user's home directory on every platform:

- **macOS / Linux:** `$HOME/.copilot` (e.g. `/Users/<you>/.copilot`)
- **Windows:** `%USERPROFILE%\.copilot` (e.g. `C:\Users\<you>\.copilot`), which PowerShell exposes as `$HOME`

## Procedure

Pick the code block matching the host OS. Run the shell commands directly; do not hardcode a username — always resolve the home directory dynamically.

1. **Resolve the home directory.** Use `$HOME` in both PowerShell and bash. Build the source and destination folder paths from it.

2. **Verify the source exists.** Confirm the source folder, both required source files (`extension.mjs`, `package.json`), and the required `workflows/` directory are present.
   - If the source folder does not exist, stop and tell the user the Radius plugin is not installed under `radius-plugins/radius`; there is nothing to copy. Do not attempt to download or synthesize the files.

3. **Ensure the destination folder exists.** Create `~/.copilot/extensions/radius/` if it is missing.

4. **Copy the required files and workflow tree**, overwriting the files and replacing the complete destination `workflows/` directory, then copy `extension.mjs.map` if it is present:
   - `.../installed-plugins/radius-plugins/radius/extension.mjs` -> `.../extensions/radius/extension.mjs`
   - `.../installed-plugins/radius-plugins/radius/package.json` -> `.../extensions/radius/package.json`
   - `.../installed-plugins/radius-plugins/radius/workflows/` -> `.../extensions/radius/workflows/`
   - `.../installed-plugins/radius-plugins/radius/extension.mjs.map` -> `.../extensions/radius/extension.mjs.map` (skip silently when absent)

5. **Verify the copy.** Confirm both required files now exist in the destination and are non-empty, then confirm the destination workflow files match the source tree.

6. **Tell the user to reload.** The canvas is discovered at extension-load time, so instruct the user to reload extensions or restart the GitHub Copilot App for the Radius Canvas to appear.

### PowerShell (Windows)

```powershell
$src   = Join-Path $HOME '.copilot\installed-plugins\radius-plugins\radius'
$dst   = Join-Path $HOME '.copilot\extensions\radius'
$files = 'extension.mjs','package.json'
$srcWorkflows = Join-Path $src 'workflows'
$dstWorkflows = Join-Path $dst 'workflows'

if (-not (Test-Path $src)) { throw "Radius plugin not found at $src" }

# Verify both source files exist before copying anything.
foreach ($f in $files) {
    $sp = Join-Path $src $f
    if (-not (Test-Path $sp)) { throw "Missing source file: $sp" }
}
if (-not (Test-Path -PathType Container $srcWorkflows)) {
    throw "Missing source workflow directory: $srcWorkflows"
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null

foreach ($f in $files) {
    Copy-Item -Path (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force -ErrorAction Stop
}

# Replace the whole workflow contract so templates and actions cannot remain
# stale beside a newer extension.mjs.
$workflowsTmp = Join-Path $dst "workflows.tmp-$PID"
if (Test-Path $workflowsTmp) {
    Remove-Item -Path $workflowsTmp -Recurse -Force -ErrorAction Stop
}
Copy-Item -Path $srcWorkflows -Destination $workflowsTmp -Recurse -Force -ErrorAction Stop
if (Test-Path $dstWorkflows) {
    Remove-Item -Path $dstWorkflows -Recurse -Force -ErrorAction Stop
}
Move-Item -Path $workflowsTmp -Destination $dstWorkflows -ErrorAction Stop

# The source map is optional; older installs do not ship one.
$map = Join-Path $src 'extension.mjs.map'
if (Test-Path $map) {
    Copy-Item -Path $map -Destination (Join-Path $dst 'extension.mjs.map') -Force -ErrorAction Stop
}

# Verify each destination file now exists, is non-empty, and matches its source.
foreach ($f in $files) {
    $sp = Join-Path $src $f
    $dp = Join-Path $dst $f
    if (-not (Test-Path $dp) -or (Get-Item $dp).Length -eq 0) {
        throw "Copy failed or produced an empty file: $dp"
    }
    if ((Get-FileHash -Path $sp -ErrorAction Stop).Hash -ne (Get-FileHash -Path $dp -ErrorAction Stop).Hash) {
        throw "Copied file does not match source: $dp"
    }
}
$sourceWorkflowFiles = Get-ChildItem -Path $srcWorkflows -Recurse -File
$destinationWorkflowFiles = Get-ChildItem -Path $dstWorkflows -Recurse -File
if ($sourceWorkflowFiles.Count -ne $destinationWorkflowFiles.Count) {
    throw "Copied workflow tree does not match source file count: $dstWorkflows"
}
foreach ($sourceFile in $sourceWorkflowFiles) {
    $relative = [IO.Path]::GetRelativePath($srcWorkflows, $sourceFile.FullName)
    $destinationFile = Join-Path $dstWorkflows $relative
    if (-not (Test-Path $destinationFile) -or
        (Get-FileHash -Path $sourceFile.FullName -ErrorAction Stop).Hash -ne
        (Get-FileHash -Path $destinationFile -ErrorAction Stop).Hash) {
        throw "Copied workflow file does not match source: $destinationFile"
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
src_workflows="$src/workflows"
dst_workflows="$dst/workflows"

[ -d "$src" ] || { echo "Radius plugin not found at $src" >&2; exit 1; }

# Verify both source files exist before copying anything.
for f in "${files[@]}"; do
  [ -f "$src/$f" ] || { echo "Missing source file: $src/$f" >&2; exit 1; }
done
[ -d "$src_workflows" ] || { echo "Missing source workflow directory: $src_workflows" >&2; exit 1; }

mkdir -p "$dst"

for f in "${files[@]}"; do
  cp -f "$src/$f" "$dst/$f"
done

# Replace the whole workflow contract so templates and actions cannot remain
# stale beside a newer extension.mjs.
workflows_tmp="$dst/workflows.tmp.$$"
trap 'rm -rf -- "$workflows_tmp"' EXIT
rm -rf -- "$workflows_tmp"
cp -R "$src_workflows" "$workflows_tmp"
rm -rf -- "$dst_workflows"
mv "$workflows_tmp" "$dst_workflows"
trap - EXIT

# The source map is optional; older installs do not ship one.
[ -f "$src/extension.mjs.map" ] && cp -f "$src/extension.mjs.map" "$dst/extension.mjs.map"

# Verify each destination file now exists and is non-empty, and that every
# workflow file matches its source.
for f in "${files[@]}"; do
  [ -s "$dst/$f" ] || { echo "Copy failed or produced an empty file: $dst/$f" >&2; exit 1; }
done
diff -qr "$src_workflows" "$dst_workflows"

ls -l "$dst"
```

## Completion checklist

- Source folder and both required source files existed (or the user was clearly told the plugin is not installed and the skill stopped).
- `~/.copilot/extensions/radius/` exists.
- `extension.mjs` and `package.json` are present and non-empty in the destination.
- `workflows/` was replaced completely and matches the installed plugin's bundled workflow tree.
- `extension.mjs.map` was copied if the source had one (its absence is not a failure).
- The user was told to reload extensions / restart the app.

## Constraints and pitfalls

- Only ever touch the `radius` plugin and the `radius` extension folder. Do not copy `skills/`, `plugin.json`, `README.md`, or any files other than those listed above.
- Always overwrite the destination files so a re-run picks up plugin updates.
- Never fabricate `extension.mjs`, `package.json`, or `workflows/` if the source is missing; the correct recovery is to (re)install the Radius plugin first.
- This is a temporary workaround. If a future GitHub Copilot App version loads plugin canvases directly from `installed-plugins`, this skill is no longer needed.
