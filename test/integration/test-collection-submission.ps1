# Integration test script for Windows PowerShell
# Requires Git and GitHub CLI to be installed

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "DollhouseMCP Collection Submission Test (PowerShell)" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

# Function to check if a command exists
function Test-Command {
    param($Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

# Check prerequisites
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

if (-not (Test-Command "git")) {
    Write-Host "[ERROR] Git is not installed" -ForegroundColor Red
    Write-Host "Please install from https://git-scm.com/download/win"
    exit 1
}

if (-not (Test-Command "gh")) {
    Write-Host "[ERROR] GitHub CLI is not installed" -ForegroundColor Red
    Write-Host "Please install from https://cli.github.com/"
    Write-Host "Or use: winget install --id GitHub.cli"
    exit 1
}

if (-not (Test-Command "bash")) {
    Write-Host "[ERROR] Git Bash is not available" -ForegroundColor Red
    Write-Host "Please ensure Git for Windows is properly installed"
    exit 1
}

Write-Host "[✓] Prerequisites checked" -ForegroundColor Green

# Detect GitHub user
Write-Host "Detecting GitHub user..." -ForegroundColor Yellow

$githubUser = $env:GITHUB_USER
if (-not $githubUser) {
    try {
        $githubUser = & gh api user --jq .login 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub CLI command failed"
        }
    } catch {
        Write-Host "GitHub CLI detection failed: $_" -ForegroundColor Yellow
        Write-Host "Trying git config as fallback..." -ForegroundColor Yellow
        
        try {
            $githubUser = & git config --global github.user 2>$null
            if (-not $githubUser) {
                # Try regular user.name as last resort
                $githubUser = & git config --global user.name 2>$null
                if ($githubUser) {
                    Write-Host "Warning: Using git user.name which may not match GitHub username" -ForegroundColor Yellow
                }
            }
        } catch {
            Write-Host "Git config detection also failed: $_" -ForegroundColor Red
        }
    }
}

if ($githubUser) {
    Write-Host "[✓] Detected GitHub user: $githubUser" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Could not detect GitHub user" -ForegroundColor Red
    Write-Host "Please set GITHUB_USER environment variable or run: gh auth login"
    exit 1
}

# Generate test data names with random suffix
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$randomSuffix = "{0:x4}" -f (Get-Random -Maximum 65536)
$testPersonaManual = "Test-Manual-$timestamp-$randomSuffix"
$testPersonaAuto = "Test-Auto-$timestamp-$randomSuffix"

Write-Host ""
Write-Host "Test Configuration:" -ForegroundColor Yellow
Write-Host "  GitHub User: $githubUser"
Write-Host "  Manual Test: $testPersonaManual"
Write-Host "  Auto Test: $testPersonaAuto"
Write-Host ""

# Option to run the full bash script
$runBash = Read-Host "Run full bash test suite? (y/n)"
if ($runBash -eq 'y') {
    Write-Host "Running bash test suite..." -ForegroundColor Yellow
    & bash "$PSScriptRoot/test-collection-submission.sh"
} else {
    Write-Host ""
    Write-Host "Quick Test Instructions for Claude Desktop:" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Test WITHOUT auto-submit:" -ForegroundColor Yellow
    Write-Host "   configure_collection_submission autoSubmit: false"
    Write-Host "   submit_content `"$testPersonaManual`""
    Write-Host ""
    Write-Host "2. Test WITH auto-submit:" -ForegroundColor Yellow
    Write-Host "   configure_collection_submission autoSubmit: true"
    Write-Host "   submit_content `"$testPersonaAuto`""
    Write-Host ""
    Write-Host "3. Check results:" -ForegroundColor Yellow
    Write-Host "   Portfolio: https://github.com/$githubUser/dollhouse-portfolio"
    Write-Host "   Collection: https://github.com/DollhouseMCP/collection/issues"
    Write-Host ""
}

Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")