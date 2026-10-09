<#
.SYNOPSIS
  Starts the GitHub Copilot desktop app with the WebView2 CDP port open.

.DESCRIPTION
  Fails if the app is already running. Sets
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS only for the child process, starts
  github.exe, and waits until http://127.0.0.1:<Port>/json/version answers.

  WARNING: while the port is open, any local process can fully control the
  app and the signed-in account. Quit the app after the test run.

.EXAMPLE
  .\scripts\launch-app.ps1
  .\scripts\launch-app.ps1 -Port 9333 -TimeoutSeconds 90
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9222,

  [ValidateRange(1, 600)]
  [int]$TimeoutSeconds = 60,

  [string]$AppPath = (Join-Path $env:LOCALAPPDATA 'Programs\GitHub Copilot\github.exe')
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
  throw 'This script supports Windows only (WebView2). macOS and Linux have no CDP endpoint.'
}

if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
  throw "GitHub Copilot app not found at '$AppPath'. Use -AppPath to set the path."
}
$resolvedApp = (Resolve-Path -LiteralPath $AppPath).Path

$running = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($resolvedApp)) -ErrorAction SilentlyContinue |
  Where-Object { -not $_.Path -or $_.Path -eq $resolvedApp }
if ($running) {
  $ids = ($running | ForEach-Object { $_.Id }) -join ', '
  throw ("The GitHub Copilot app is running (PID $ids). Quit the app fully " +
    '(also from the system tray), then run this script again. ' +
    'Note: quitting the app ends all running agent sessions.')
}

$versionUrl = "http://127.0.0.1:$Port/json/version"

function Test-CdpEndpoint([string]$Url = $versionUrl) {
  try {
    return Invoke-RestMethod -Uri $Url -TimeoutSec 2 -UseBasicParsing
  } catch {
    return $null
  }
}

# Use loopback literals, not "localhost": a canvas opens a second WebView2
# browser process that also listens on this port, on the IPv6 loopback.
foreach ($url in @($versionUrl, "http://[::1]:$Port/json/version")) {
  if (Test-CdpEndpoint $url) {
    throw "Port $Port already answers CDP requests at $url. Close that process or use -Port."
  }
}

$debugArg = "--remote-debugging-port=$Port"
$existingArgs = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $resolvedApp
$startInfo.WorkingDirectory = Split-Path -Parent $resolvedApp
$startInfo.UseShellExecute = $false
# Set the variable for the child process only; the current shell keeps its value.
$webViewArgs = if ($existingArgs) { "$existingArgs $debugArg" } else { $debugArg }
$startInfo.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = $webViewArgs

$process = [System.Diagnostics.Process]::Start($startInfo)
Write-Host "Started $resolvedApp (PID $($process.Id)). Waiting for $versionUrl ..."

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $version = Test-CdpEndpoint
  if ($version) {
    Write-Host "CDP endpoint is ready: $($version.Browser)"
    Write-Host "Run 'npm test'. Quit the app after the test run to close port $Port."
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

$state = if ($process.HasExited) { "exited with code $($process.ExitCode)" } else { 'is still running' }
throw ("Timed out after $TimeoutSeconds s waiting for $versionUrl. The app process $state. " +
  'Make sure the app was fully closed before launch, because a running instance ignores the new arguments.')
