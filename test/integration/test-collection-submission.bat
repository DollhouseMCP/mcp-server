@echo off
REM Integration test script for Windows users
REM Requires Git Bash to be installed (comes with Git for Windows)

echo =======================================================
echo DollhouseMCP Collection Submission Test (Windows)
echo =======================================================
echo.

REM Check if Git Bash is available
where bash >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git Bash is not in PATH
    echo Please install Git for Windows from https://git-scm.com/download/win
    echo Or add Git Bash to your PATH
    exit /b 1
)

REM Check if gh CLI is available
where gh >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] GitHub CLI is not installed
    echo Please install from https://cli.github.com/
    echo Or use: winget install --id GitHub.cli
    exit /b 1
)

REM Run the bash script using Git Bash
echo Running test suite using Git Bash...
echo.
bash "%~dp0test-collection-submission.sh" %*

REM Check exit code
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Test script failed with exit code %errorlevel%
    exit /b %errorlevel%
)

echo.
echo Test script completed successfully!
pause