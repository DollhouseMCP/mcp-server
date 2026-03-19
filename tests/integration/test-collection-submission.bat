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

REM Check Git Bash version for compatibility
for /f "tokens=3" %%v in ('bash --version 2^>nul ^| findstr /R "version [0-9]"') do set BASH_VERSION=%%v
if "%BASH_VERSION%"=="" (
    echo [WARNING] Could not determine Git Bash version
    echo Continuing anyway, but you may experience issues
) else (
    echo [INFO] Found Git Bash version %BASH_VERSION%
    REM Check for minimum version (4.0 or higher recommended)
    for /f "tokens=1 delims=." %%a in ("%BASH_VERSION%") do set MAJOR_VERSION=%%a
    if %%a LSS 4 (
        echo [WARNING] Git Bash version %BASH_VERSION% is old
        echo Version 4.0 or higher is recommended for full compatibility
        echo You can update Git for Windows from https://git-scm.com/download/win
    )
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