# LLM Wiki pre-publish gate.
#
# Run on the DEVELOPMENT machine before uploading files to the server:
#
#     .\precheck.ps1            # type-check + tests          (~1 min)
#     .\precheck.ps1 -Build     # ...plus a local next build  (a few minutes)
#
# Why this exists: there is no local "publish artifact". The server container
# runs `pnpm install` + `next build` itself, so a compile error would otherwise
# only surface AFTER the upload - as a container that refuses to start. This
# script moves that failure left, to the machine where it is cheap to fix.
#
# KNOWN FALSE ALARM: dev-box disk I/O occasionally degrades badly (a temp-dir
# deletion can take 30s+). Vitest then reports "Hook timed out in 10000ms" on
# tests that are perfectly fine. If that happens, re-run later or use
# -SkipTests; do NOT go editing code to chase it.
#
# Exit code 0 = safe to publish. Non-zero = do not upload yet.
#
# NOTE: deliberately ASCII-only. Windows PowerShell 5.1 reads a .ps1 saved as
# UTF-8 *without BOM* using the system ANSI codepage, which garbles non-ASCII
# text and can break string/brace parsing outright.

param(
    [switch] $Build,
    [switch] $SkipTests
)

$ErrorActionPreference = "Stop"

# Child processes (check-i18n.mjs, vitest) print UTF-8. PowerShell's default
# console encoding is the OEM/ANSI codepage, which turns their punctuation into
# mojibake here. This script's own text stays ASCII: handling of an encoding
# mismatch never depends on encoding being handled correctly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$repoRoot = $PSScriptRoot
$failed = @()

# Runs a native command and returns ITS exit code, without letting PowerShell
# abort the script. Under $ErrorActionPreference='Stop' (needed for real bugs
# like Test-Path on a missing file), ANY stderr output from a native command is
# converted into a terminating NativeCommandError — so `next build` merely
# printing a warning kills the run and reports a build failure that never
# happened. Every tool below writes to stderr on occasion; none of that is a
# failure signal, only the exit code is.
function Invoke-Native {
    param(
        [string] $Exe,
        [string[]] $Args
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Exe @Args
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return $code
}

Write-Host "== pre-publish check ==" -ForegroundColor Cyan

# ---- pick a Node binary -----------------------------------------------------
# better-sqlite3 is compiled against a specific Node ABI. This checkout targets
# Node 20; under Node 22 the native module fails to load and the test suite goes
# red for reasons that have nothing to do with the code.
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
# an NVM_HOME scan can surface a decade-old v14 next to the v20 the build target
# expects, and "first match" then hands us a runtime that cannot even run vitest.
foreach ($c in $candidates) {
    if (-not $c) { continue }
    $m = Get-NodeMajorVersion -Exe $c
    if ($m -ne $null -and $m -le 20 -and ($nodeMajor -eq $null -or $m -gt $nodeMajor)) {
        $nodeExe = $c; $nodeMajor = $m
    }
}
if (-not $nodeExe) { $nodeExe = "node"; $nodeMajor = Get-NodeMajorVersion -Exe "node" }

Write-Host ("[node ] {0}  (v{1})" -f $nodeExe, $nodeMajor)
if ($nodeMajor -ne $null -and $nodeMajor -gt 20) {
    Write-Host "[WARN ] better-sqlite3 targets Node 20; results below may be misleading." -ForegroundColor Yellow
}
Write-Host "[note ] each step prints when it starts and how long it took. If one seems" -ForegroundColor DarkGray
Write-Host "[note ] frozen, this box's disk I/O is degrading again (a known, temporary" -ForegroundColor DarkGray
Write-Host "[note ] condition) - press Ctrl+C and retry later. That is not a code fault." -ForegroundColor DarkGray

# ---- 1. type-check ----------------------------------------------------------
$tsc = Join-Path $repoRoot "node_modules\typescript\bin\tsc"
foreach ($pkg in @("packages\core", "packages\llm", "apps\web")) {
    $dir = Join-Path $repoRoot $pkg
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Push-Location $dir
    Write-Host ("[....] type-check  {0} ..." -f $pkg) -ForegroundColor DarkGray
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = ((Invoke-Native -Exe $nodeExe -Args @($tsc, "--noEmit")) -eq 0)
    $sw.Stop()
    Pop-Location
    if ($ok) {
        Write-Host ("[ OK  ] type-check  {0}  ({1:n1}s)" -f $pkg, $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    } else {
        Write-Host ("[FAIL ] type-check  {0}  ({1:n1}s)" -f $pkg, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        $failed += "type-check:$pkg"
    }
}

# ---- 2. i18n key parity -----------------------------------------------------
$i18n = Join-Path $repoRoot "apps\web\scripts\check-i18n.mjs"
if (Test-Path -LiteralPath $i18n) {
    Push-Location (Join-Path $repoRoot "apps\web")
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = ((Invoke-Native -Exe $nodeExe -Args @($i18n)) -eq 0)
    $sw.Stop()
    Pop-Location
    if ($ok) {
        Write-Host ("[ OK  ] i18n keys  ({0:n1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    } else {
        Write-Host ("[FAIL ] i18n keys  ({0:n1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        $failed += "i18n"
    }
}

# ---- 3. unit tests ----------------------------------------------------------
if (-not $SkipTests) {
    $vitest = Join-Path $repoRoot "node_modules\vitest\vitest.mjs"
    Push-Location $repoRoot
    Write-Host "[....] unit tests (vitest, spawns workers) ..." -ForegroundColor DarkGray
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = ((Invoke-Native -Exe $nodeExe -Args @($vitest, "run", "--hookTimeout", "120000")) -eq 0)
    $sw.Stop()
    Pop-Location
    if ($ok) {
        Write-Host ("[ OK  ] unit tests  ({0:n1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    } else {
        Write-Host ("[FAIL ] unit tests  ({0:n1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Red
        $failed += "tests"
    }
} else {
    Write-Host "[SKIP ] unit tests" -ForegroundColor DarkGray
}

# ---- 4. optional: try a real build here -------------------------------------
# Mirrors what the container does. The output (.next) stays LOCAL - it must
# never be uploaded (Linux container recompiles anyway, and a Windows-built
# .next with native modules would be unusable).
if ($Build) {
    Write-Host "[build] next build (local dry run; output is NOT uploaded)" -ForegroundColor Cyan

    # Drive Next directly instead of going through pnpm on purpose:
    #   * `pnpm` here is a corepack shim that has to download/resolve @pnpm/exe
    #     at call time - it can fail for reasons unrelated to the code;
    #   * `pnpm --filter @llm-wiki/web build` only wraps this same binary.
    # Invoking next's own bin skips a layer that can lie about the result.
    $nextBin = Join-Path $repoRoot "apps\web\node_modules\next\dist\bin\next"
    if (-not (Test-Path -LiteralPath $nextBin)) {
        Write-Host "[FAIL ] next build - next binary not found at $nextBin" -ForegroundColor Red
        Write-Host "        Run 'pnpm install' first." -ForegroundColor Yellow
        $failed += "build"
    } else {
        Push-Location (Join-Path $repoRoot "apps\web")
        $ok = ((Invoke-Native -Exe $nodeExe -Args @($nextBin, "build")) -eq 0)
        Pop-Location
        if ($ok) {
            Write-Host "[ OK  ] next build" -ForegroundColor Green
        } else {
            Write-Host "[FAIL ] next build" -ForegroundColor Red
            $failed += "build"
        }
    }
}

# ---- verdict ----------------------------------------------------------------
Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "== READY TO PUBLISH ==" -ForegroundColor Green
    Write-Host "Next: upload apps, packages, package.json, pnpm-lock.yaml,"
    Write-Host "      pnpm-workspace.yaml to /srv/llm-wiki/app/  (see DEPLOY.md)"
    exit 0
} else {
    Write-Host ("== DO NOT PUBLISH - failed: {0} ==" -f ($failed -join ", ")) -ForegroundColor Red
    exit 1
}
