#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
    Packs LLM Wiki application sources into a deployable tarball.

.DESCRIPTION
    Runs on the DEVELOPMENT machine (Windows). The resulting llm-wiki-app.tgz
    is what you copy to the server and feed to update.sh.

    Uses `git archive`, which packs ONLY tracked files. That is the point:
    node_modules/, .next/, apps/web/wikis/ and .env.local are all gitignored,
    so they can never leak into a release bundle. It also means:

        *** UNCOMMITTED CHANGES ARE SILENTLY DROPPED FROM THE BUNDLE ***

    Newly created files (Dockerfile, llm-wiki.config.json, ...) are untracked
    until you `git add` them, so always commit before packing. This script
    refuses to produce a bundle that is missing its deploy-kit entries.

.EXAMPLE
    .\pack-for-deploy.ps1
    .\pack-for-deploy.ps1 -Ref v1.2.4 -OutFile C:\tmp\release.tgz
#>

[CmdletBinding()]
param(
    [string] $Ref = "HEAD",
    [string] $OutFile = ""
)

$ErrorActionPreference = "Stop"

# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as the
# system ANSI codepage (GBK on zh-CN hosts), which corrupts non-ASCII bytes and
# can swallow quotes/braces, producing bogus ParseException errors.

$RepoRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($OutFile)) {
    $OutFile = Join-Path $RepoRoot "llm-wiki-app.tgz"
}

if (-not (Test-Path (Join-Path $RepoRoot "pnpm-workspace.yaml"))) {
    Write-Host "[pack] ERROR: pnpm-workspace.yaml not found under $RepoRoot" -ForegroundColor Red
    exit 1
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host "[pack] ERROR: git was not found in PATH." -ForegroundColor Red
    exit 1
}

# --- 1. warn about uncommitted work -----------------------------------------
$dirty = @(& git -C $RepoRoot status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Host "[pack] WARNING: uncommitted changes exist and will NOT be packed." -ForegroundColor Yellow
    foreach ($line in ($dirty | Select-Object -First 10)) {
        Write-Host "        $line"
    }
    Write-Host "[pack] Run 'git add -A && git commit' first if this is not what you want." -ForegroundColor Yellow
    Write-Host ""
}

# --- 2. create the archive ---------------------------------------------------
Write-Host "[pack] packing $Ref -> $OutFile"
& git -C $RepoRoot archive --format=tar.gz --prefix=app/ -o $OutFile $Ref
if ($LASTEXITCODE -ne 0) {
    Write-Host "[pack] ERROR: git archive failed." -ForegroundColor Red
    exit 1
}

# --- 3. verify the bundle ----------------------------------------------------
# Catching a broken bundle here costs seconds; catching it on the server costs
# a failed deploy. Both checks are hard failures on purpose.

$entries = @(& tar -tzf $OutFile)
if ($LASTEXITCODE -ne 0) {
    Write-Host "[pack] ERROR: cannot read back the archive with 'tar -tzf'." -ForegroundColor Red
    exit 1
}

# 3a. required entries - deploy kit + runtime config + lockfile
$required = @(
    "app/Dockerfile",
    "app/docker-compose.yml",
    "app/docker-entrypoint.sh",
    "app/update.sh",
    "app/package.json",
    "app/pnpm-lock.yaml",
    "app/pnpm-workspace.yaml",
    "app/apps/web/llm-wiki.config.json"
)

$missing = @()
foreach ($r in $required) {
    if ($entries -notcontains $r) { $missing += $r }
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "[pack] ERROR: bundle is missing required entries:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "        - $m" -ForegroundColor Red }
    Write-Host ""
    Write-Host "[pack] Most likely cause: the file is untracked, so 'git archive' skipped it." -ForegroundColor Yellow
    Write-Host "[pack] Fix:  git add -A && git commit -m '...'   then re-run this script." -ForegroundColor Yellow
    exit 1
}

# 3b. forbidden entries - secrets, native deps, wiki data
$leaks = @( $entries | Where-Object {
        $_ -match '(^|/)node_modules/' -or `
            $_ -match '(^|/)\.env(\.|$)' -or `
            $_ -match '(^|/)apps/web/wikis/' -or `
            $_ -match '(^|/)\.next/'
    } )

if ($leaks.Count -gt 0) {
    Write-Host ""
    Write-Host "[pack] ERROR: bundle contains entries that must never be shipped:" -ForegroundColor Red
    foreach ($l in ($leaks | Select-Object -First 10)) { Write-Host "        - $l" -ForegroundColor Red }
    Write-Host ""
    Write-Host "[pack] Fix: make sure they are listed in .gitignore, then re-run." -ForegroundColor Yellow
    exit 1
}

# --- 4. report ---------------------------------------------------------------
$item = Get-Item $OutFile
$sizeMb = [math]::Round($item.Length / 1MB, 2)
Write-Host "[pack] verified: $($entries.Count) entries, kit + config present, no secrets"
Write-Host "[pack] done: $($item.Name) ($sizeMb MB)"
Write-Host ""
Write-Host "Next steps on the server:"
Write-Host "    cd /srv/llm-wiki"
Write-Host "    ./update.sh /path/to/$($item.Name)"
