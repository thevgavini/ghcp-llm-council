<#
.SYNOPSIS
    Installs the llm-council skill into Copilot CLI's skill directory.
.DESCRIPTION
    Checks prerequisites (Node 20+, gh CLI, gh auth), installs missing pieces,
    then copies skills/llm-council into ~/.copilot/skills/llm-council.
    Automatically replaces any existing installation.
#>
$ErrorActionPreference = 'Stop'

# ── Prerequisites ──────────────────────────────────────────────────────────

function Test-Command($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# Node.js 20+
Write-Host "Checking Node.js..." -ForegroundColor Cyan
if (-not (Test-Command 'node')) {
    Write-Error "Node.js is not installed. Install Node 20+ from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS"
    exit 1
}
$nodeVersion = (node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Error "Node.js $nodeVersion found — version 20+ required. Update from https://nodejs.org/"
    exit 1
}
Write-Host "  Node.js v$nodeVersion" -ForegroundColor Green

# GitHub CLI
Write-Host "Checking GitHub CLI..." -ForegroundColor Cyan
$ghPath = $null
if (Test-Command 'gh') {
    $ghPath = 'gh'
} elseif (Test-Path "$env:ProgramFiles\GitHub CLI\gh.exe") {
    $ghPath = "$env:ProgramFiles\GitHub CLI\gh.exe"
}

if (-not $ghPath) {
    Write-Host "  GitHub CLI not found. Installing..." -ForegroundColor Yellow
    if (Test-Command 'winget') {
        winget install GitHub.cli --accept-package-agreements --accept-source-agreements
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if (Test-Command 'gh') { $ghPath = 'gh' }
        elseif (Test-Path "$env:ProgramFiles\GitHub CLI\gh.exe") { $ghPath = "$env:ProgramFiles\GitHub CLI\gh.exe" }
    }
    if (-not $ghPath) {
        Write-Error "Could not install GitHub CLI. Install manually: https://cli.github.com/"
        exit 1
    }
    Write-Host "  GitHub CLI installed." -ForegroundColor Green
} else {
    $ghVersion = & $ghPath --version | Select-Object -First 1
    Write-Host "  $ghVersion" -ForegroundColor Green
}

# gh auth status
Write-Host "Checking GitHub authentication..." -ForegroundColor Cyan
$authOk = $false
try {
    $null = & $ghPath auth status 2>&1
    if ($LASTEXITCODE -eq 0) { $authOk = $true }
} catch {}

if (-not $authOk) {
    # Check if GITHUB_TOKEN is set as fallback
    if ($env:GITHUB_TOKEN -or $env:GH_TOKEN) {
        Write-Host "  Using GITHUB_TOKEN environment variable." -ForegroundColor Green
    } else {
        Write-Host "  Not authenticated. Starting gh auth login..." -ForegroundColor Yellow
        & $ghPath auth login
        if ($LASTEXITCODE -ne 0) {
            Write-Error "GitHub authentication failed. Run 'gh auth login' manually."
            exit 1
        }
    }
} else {
    Write-Host "  Authenticated." -ForegroundColor Green
}

# ── Install skill ──────────────────────────────────────────────────────────

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

Write-Host ""
Write-Host "Done! Skill installed to: $Dest" -ForegroundColor Green
Write-Host "Restart your Copilot CLI session, then say: ask the council <your question>" -ForegroundColor Cyan
