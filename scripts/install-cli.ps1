# Aria IDE - Install CLI Command ('aria .') into Windows PATH
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$binSource = Join-Path $scriptDir "bin\aria.js"
$userBin = Join-Path $env:USERPROFILE "bin"
$cmdFile = Join-Path $userBin "aria.cmd"

Write-Host "[Aria IDE] Installing 'aria' command into Windows PATH..." -ForegroundColor Cyan

# Create ~/bin if it doesn't exist
if (-not (Test-Path $userBin)) {
    New-Item -ItemType Directory -Path $userBin | Out-Null
}

# Create aria.cmd wrapper
$cmdContent = "@echo off`r`nnode `"$binSource`" %*`r`n"
Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII

Write-Host "✓ Created launcher at: $cmdFile" -ForegroundColor Green

# Add ~/bin to user PATH if missing
$userPath = [Environment]::GetEnvironmentVariable("PATH", [EnvironmentVariableTarget]::User)
if ($userPath -notlike "*$userBin*") {
    $newPath = "$userPath;$userBin"
    [Environment]::SetEnvironmentVariable("PATH", $newPath, [EnvironmentVariableTarget]::User)
    Write-Host "✓ Added $userBin to your User PATH!" -ForegroundColor Green
    Write-Host "Please restart your PowerShell/Terminal to refresh environment variables." -ForegroundColor Yellow
} else {
    Write-Host "✓ $userBin is already in your PATH." -ForegroundColor Green
}

Write-Host "You can now run 'aria .' in any folder!" -ForegroundColor Green
