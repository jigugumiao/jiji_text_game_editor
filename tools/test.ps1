# Run all standalone Node regression tests from the repository root.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Get-Command node -ErrorAction Stop | Out-Null
$files = @(Get-ChildItem -LiteralPath (Join-Path $root 'tests') -Filter '*.test.js' | Sort-Object Name)
if ($files.Count -eq 0) { throw 'No regression tests found.' }
$failed = @()
Push-Location $root
try {
    foreach ($file in $files) {
        Write-Host "Running $($file.Name)"
        & node $file.FullName
        if ($LASTEXITCODE -ne 0) { $failed += $file.Name }
    }
} finally { Pop-Location }
if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "All $($files.Count) test files passed." -ForegroundColor Green
