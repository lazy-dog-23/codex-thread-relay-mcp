[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $repoRoot '.codex/environments/environment.toml'

function Assert-Exists {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required path: $Path"
    }
}

Assert-Exists (Join-Path $repoRoot 'AGENTS.md')
Assert-Exists $environmentFile
Assert-Exists (Join-Path $repoRoot 'scripts/verify.ps1')
Assert-Exists (Join-Path $repoRoot 'scripts/setup.windows.ps1')
Assert-Exists (Join-Path $repoRoot 'scripts/review.ps1')

$environmentText = Get-Content -LiteralPath $environmentFile -Raw
if ($environmentText -notmatch 'setup.windows.ps1') {
    throw 'environment.toml does not reference setup.windows.ps1.'
}
if ($environmentText -notmatch 'name = "verify"') {
    throw 'environment.toml is missing the verify action.'
}
if ($environmentText -notmatch 'name = "smoke"') {
    throw 'environment.toml is missing the smoke action.'
}
if ($environmentText -notmatch 'name = "review"') {
    throw 'environment.toml is missing the review action.'
}

Write-Host 'Smoke precheck passed.'
