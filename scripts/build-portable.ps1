$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot "src-tauri"
$targetRoot = Join-Path $tauriRoot "target\portable"
$artifactRoot = Join-Path $projectRoot "artifacts\portable"
$configuration = Get-Content -Raw (Join-Path $tauriRoot "tauri.conf.json") | ConvertFrom-Json
$artifactName = "API-Explorer-$($configuration.version)-Portable-x64.exe"
$builtExecutable = Join-Path $targetRoot "release\api-explorer.exe"
$portableExecutable = Join-Path $artifactRoot $artifactName

Push-Location $projectRoot
try {
    $previousTargetDirectory = $env:CARGO_TARGET_DIR
    $env:CARGO_TARGET_DIR = $targetRoot
    try {
        & npx.cmd tauri build --no-bundle --features portable --ci
        if ($LASTEXITCODE -ne 0) {
            throw "Portable Tauri build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        if ($null -eq $previousTargetDirectory) {
            Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        }
        else {
            $env:CARGO_TARGET_DIR = $previousTargetDirectory
        }
    }

    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    Copy-Item -LiteralPath $builtExecutable -Destination $portableExecutable -Force
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($portableExecutable)
    try {
        $hashBytes = $sha256.ComputeHash($stream)
        $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $stream.Dispose()
        $sha256.Dispose()
    }

    Write-Output "Portable executable: $portableExecutable"
    Write-Output "SHA256: $hash"
}
finally {
    Pop-Location
}
