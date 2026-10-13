# LLM Wiki one-click launcher
# Usage: from anywhere  .\start-my-wiki.ps1
#
# Config is persisted in files - no secrets live in this script:
#   apps\web\llm-wiki.config.json -- port, wiki dirs, default product, model slots (safe to commit)
#   apps\web\.env.local           -- provider API keys (git-ignored)
# Env vars still override the config file: env > config file > built-in defaults.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
# .ps1 saved as UTF-8 *without BOM* using the system ANSI codepage, which
# garbles non-ASCII text and can break string/brace parsing outright. Keeping it
# ASCII makes the script immune to that regardless of how it gets re-saved.

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$webDir = Join-Path $repoRoot "apps\web"
$configFile = Join-Path $webDir "llm-wiki.config.json"
$envFile = Join-Path $webDir ".env.local"

if (-not (Test-Path -LiteralPath $webDir)) {
    Write-Host "[ERROR] web app not found: $webDir" -ForegroundColor Red
    Write-Host "        Run this script from the repo root, or move it back there." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Host "[ERROR] config file not found: $configFile" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Host "[WARN ] no key file: $envFile (copy .env.example and fill in your keys)" -ForegroundColor Yellow
}

# ---- pick a Node binary -----------------------------------------------------
# better-sqlite3 is a native module compiled against a specific Node ABI. This
# checkout is built for Node 20; running under Node 22 fails to load it, and the
# wiki boots with no database. So prefer Node 20 when one is available.
function Get-NodeMajorVersion {
    param([string]$Exe)
    if (-not $Exe) { return $null }
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $out = (& $Exe -v 2>$null | Out-String)
        if ($out -match "v(\d+)\.") { return [int]$Matches[1] }
    } catch {}
    finally { $ErrorActionPreference = $prev }
    return $null
}

$candidates = @()
if ($env:LLM_WIKI_NODE) { $candidates += $env:LLM_WIKI_NODE }
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }
if ($env:NVM_HOME) {
    $candidates += (Get-ChildItem -Path $env:NVM_HOME -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName)
}
$candidates += @(
    (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
    "E:\DevelopProgramFiles\nvm\nodejs\node.exe"
)

$nodeExe = $null
$nodeMajor = $null
# Pick the NEWEST Node that is still <= 20, not merely the first acceptable one:
# an NVM_HOME scan can surface a decade-old v14 next to the v20 this checkout
# targets, and "first match" would then start the server on the ancient binary.
foreach ($c in $candidates) {
    if (-not $c) { continue }
    $m = Get-NodeMajorVersion -Exe $c
    if ($m -ne $null -and $m -le 20 -and ($nodeMajor -eq $null -or $m -gt $nodeMajor)) {
        $nodeExe = $c; $nodeMajor = $m
    }
}

if (-not $nodeExe) {
    # No Node <=20 anywhere: fall back to whatever is on PATH and warn loudly.
    $nodeExe = "node"
    $nodeMajor = Get-NodeMajorVersion -Exe "node"
    Write-Host "[WARN ] no Node 20 found; better-sqlite3 is built for Node 20." -ForegroundColor Yellow
    Write-Host "        Running on Node $nodeMajor - the database may fail to load." -ForegroundColor Yellow
    Write-Host "        Fix: set `$env:LLM_WIKI_NODE to a Node 20 binary, or run" -ForegroundColor Yellow
    Write-Host "             'pnpm rebuild better-sqlite3' under this Node version." -ForegroundColor Yellow
}

# ---- read port / default product from the config file -----------------------
$port = 3737
$defaultProduct = $null
try {
    $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.server.port) { $port = $cfg.server.port }
    if ($cfg.wiki.defaultProduct) { $defaultProduct = $cfg.wiki.defaultProduct }
} catch {
    Write-Host "[WARN ] could not parse config; falling back to port 3737: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "config  : $configFile" -ForegroundColor Gray
Write-Host "node    : $nodeExe (v$nodeMajor)" -ForegroundColor Gray
if ($defaultProduct) { Write-Host "product : $defaultProduct" -ForegroundColor Gray }
Write-Host "url     : http://localhost:$port" -ForegroundColor Green
Write-Host ""

Push-Location $webDir
try {
    # The CLI spawns the Next server with process.execPath, so the Node version
    # picked above propagates to the server process as well.
    & $nodeExe ".\bin\llm-wiki.mjs" start --port $port --no-open
} finally {
    Pop-Location
}
