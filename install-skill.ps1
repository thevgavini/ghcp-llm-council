<#
.SYNOPSIS
    Installs the llm-council skill into Copilot CLI's skill directory.
.DESCRIPTION
    Copies the skills/llm-council folder from this repository into
    ~/.copilot/skills/llm-council. Automatically replaces any existing
    installation.
#>
$ErrorActionPreference = 'Stop'

$SkillName = 'llm-council'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $RepoRoot "skills\$SkillName"
$DestRoot = Join-Path $env:USERPROFILE ".copilot\skills"
$Dest = Join-Path $DestRoot $SkillName

if (-not (Test-Path $Source)) {
    Write-Error "Source skill not found at: $Source"
    exit 1
}

if (-not (Test-Path $DestRoot)) {
    New-Item -ItemType Directory -Path $DestRoot -Force | Out-Null
}

if (Test-Path $Dest) {
    Write-Host "Replacing existing installation..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $Dest
}

Write-Host "Installing '$SkillName' skill..." -ForegroundColor Cyan
Copy-Item -Recurse -Path $Source -Destination $Dest

Write-Host "Installed to: $Dest" -ForegroundColor Green
Write-Host "Restart your Copilot CLI session, then say: ask the council <your question>" -ForegroundColor Cyan
