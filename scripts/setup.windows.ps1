[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliDir = Join-Path $repoRoot 'tools/codex-supervisor'

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-ForwardSlashPath {
    param([Parameter(Mandatory)][string]$Path)
    return $Path.Replace('\', '/')
}

function Add-GitSafeDirectory {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        return
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $normalized = Get-ForwardSlashPath -Path ((Resolve-Path -LiteralPath $Path).Path)
    $existing = @(& git config --global --get-all safe.directory 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $existing = @()
    }

    if ($existing -contains $normalized) {
        return
    }

    & git config --global --add safe.directory $normalized
    if ($LASTEXITCODE -ne 0) {
        throw "git config --global --add safe.directory failed for $normalized."
    }
}

Ensure-Directory -Path (Join-Path $repoRoot 'autonomy/locks')
Ensure-Directory -Path (Join-Path $repoRoot '.codex/environments')

if (Test-Path -LiteralPath (Join-Path $repoRoot '.git')) {
    Add-GitSafeDirectory -Path $repoRoot

    $parent = Split-Path -Path $repoRoot -Parent
    $leaf = Split-Path -Path $repoRoot -Leaf
    $backgroundPath = Join-Path $parent ($leaf + '.__codex_bg')
    if (Test-Path -LiteralPath $backgroundPath) {
        Add-GitSafeDirectory -Path $backgroundPath
    }
}

if (Test-Path -LiteralPath (Join-Path $cliDir 'package.json')) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is required to prepare tools/codex-supervisor.'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $cliDir 'node_modules'))) {
        Push-Location $cliDir
        try {
            if (Test-Path -LiteralPath (Join-Path $cliDir 'package-lock.json')) {
                & npm ci
            } else {
                & npm install
            }
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }
    }
}

Write-Host 'setup.windows.ps1 completed successfully.'
