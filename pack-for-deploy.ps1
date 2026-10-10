#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
    Packs LLM Wiki into a "release" folder ready to upload.

.DESCRIPTION
    Run on the DEVELOPMENT machine (Windows). After it finishes you get:

        release/
          llm-wiki-app.tgz   <- application code (upload every update)
          docker-compose.yml <- container recipe (upload ONCE)
          update.sh          <- one-command updater (upload ONCE)

    IMPORTANT: packing uses `git archive`, which only includes files git is
    already tracking. New files (Dockerfile, llm-wiki.config.json, ...) are
    untracked until you `git add` them, so COMMIT BEFORE PACKING. This script
    hard-fails if the bundle is missing anything it needs.

.EXAMPLE
    .\pack-for-deploy.ps1
#>

[CmdletBinding()]
param(
    [string] $Ref = "HEAD"
)

$ErrorActionPreference = "Stop"

# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as the
# system ANSI codepage (GBK on zh-CN hosts), which corrupts non-ASCII bytes and
# can swallow quotes/braces, producing bogus ParseException errors.

$RepoRoot = $PSScriptRoot
$ReleaseDir = Join-Path $RepoRoot "release"
$OutFile = Join-Path $ReleaseDir "llm-wiki-app.tgz"

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
    Write-Host "[pack] WARNING: uncommitted changes will NOT be packed." -ForegroundColor Yellow
    foreach ($line in ($dirty | Select-Object -First 10)) {
        Write-Host "        $line"
    }
    Write-Host "[pack] Run:  git add -A && git commit -m '...'   then re-run." -ForegroundColor Yellow
    Write-Host ""
}

# --- 2. archive the code -----------------------------------------------------
if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Path $ReleaseDir | Out-Null }
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

Write-Host "[pack] packing $Ref -> release/llm-wiki-app.tgz"
& git -C $RepoRoot archive --format=tar.gz --prefix=app/ -o $OutFile $Ref
if ($LASTEXITCODE -ne 0) {
    Write-Host "[pack] ERROR: git archive failed." -ForegroundColor Red
    exit 1
}

# --- 3. verify the bundle ----------------------------------------------------
$entries = @(& tar -tzf $OutFile)
if ($LASTEXITCODE -ne 0) {
    Write-Host "[pack] ERROR: cannot read back the archive with 'tar -tzf'." -ForegroundColor Red
    exit 1
}

$required = @(
    "app/Dockerfile",
    "app/docker-entrypoint.sh",
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
    Write-Host "[pack] ERROR: bundle is missing required files:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "        - $m" -ForegroundColor Red }
    Write-Host ""
    Write-Host "[pack] Cause: they are untracked, so 'git archive' skipped them." -ForegroundColor Yellow
    Write-Host "[pack] Fix:   git add -A && git commit -m '...'   then re-run." -ForegroundColor Yellow
    exit 1
}

$leaks = @( $entries | Where-Object {
        $_ -match '(^|/)node_modules/' -or `
            $_ -match '(^|/)\.env(\.|$)' -or `
            $_ -match '(^|/)apps/web/wikis/' -or `
            $_ -match '(^|/)\.next/'
    } )

if ($leaks.Count -gt 0) {
    Write-Host ""
    Write-Host "[pack] ERROR: bundle contains files that must never be shipped:" -ForegroundColor Red
    foreach ($l in ($leaks | Select-Object -First 10)) { Write-Host "        - $l" -ForegroundColor Red }
    Write-Host ""
    Write-Host "[pack] Fix: ensure they are in .gitignore, then re-run." -ForegroundColor Yellow
    exit 1
}

# --- 4. copy the deploy kit next to the archive -------------------------------
# update.sh and docker-compose.yml must live OUTSIDE ./app: update.sh replaces
# ./app wholesale, and would delete itself if it lived inside.
#
# They are copied from the WORKING TREE, and on Windows `core.autocrlf=true`
# makes that tree CRLF (the LF/CRLF warnings you see during `git add`). A CRLF
# bash script dies on Linux with `/usr/bin/env: 'bash\r'` or `$'\r': command
# not found`, so both files are re-written here with LF endings and no BOM.
# (The .tgz is safe regardless: `git archive` always emits the repo's LF form.)
$kit = @("docker-compose.yml", "update.sh")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($f in $kit) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src) {
        $text = [System.IO.File]::ReadAllText($src)
        $text = $text -replace "`r`n", "`n"
        [System.IO.File]::WriteAllText((Join-Path $ReleaseDir $f), $text, $utf8NoBom)
    } else {
        Write-Host "[pack] ERROR: deploy kit file missing: $f" -ForegroundColor Red
        exit 1
    }
}

# --- 5. report ----------------------------------------------------------------
$item = Get-Item $OutFile
$sizeMb = [math]::Round($item.Length / 1MB, 2)
Write-Host "[pack] verified: $($entries.Count) entries, kit + config present, no secrets"
Write-Host ""
Write-Host "release/ is ready:"
Write-Host "    $ReleaseDir\llm-wiki-app.tgz   ($sizeMb MB)"
foreach ($f in $kit) { Write-Host "    $ReleaseDir\$f" }
Write-Host ""
Write-Host "Upload ALL of release/ to /srv/llm-wiki/ on the server, then run:"
Write-Host "    cd /srv/llm-wiki && ./update.sh ./llm-wiki-app.tgz"
