param(
    [Parameter(Mandatory = $true)]
    [string]$KaiDirectory,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "animetvcut_skip"
$optionsSource = Join-Path $PSScriptRoot "script-opts\animetvcut_skip.conf"
$portable = Join-Path $KaiDirectory "portable_config"
$destination = Join-Path $portable "scripts\animetvcut_skip"
$optionsDirectory = Join-Path $portable "script-opts"
$optionsDestination = Join-Path $optionsDirectory "animetvcut_skip.conf"

if (-not (Test-Path -LiteralPath $portable -PathType Container)) {
    throw "The selected directory is not a Stremio-Kai installation (portable_config missing)."
}
if ((Test-Path -LiteralPath $destination) -and -not $Force) {
    $same = $true
    foreach ($name in @("core.lua", "main.lua", "fetch_segments.py")) {
        $existing = Join-Path $destination $name
        $shipped = Join-Path $source $name
        if ((-not (Test-Path -LiteralPath $existing -PathType Leaf)) -or
            ((Get-FileHash -LiteralPath $existing).Hash -ne (Get-FileHash -LiteralPath $shipped).Hash)) {
            $same = $false
            break
        }
    }
    if ($same) {
        Write-Host "AnimeTVCut companion is already installed and current."
        exit 0
    }
    throw "AnimeTVCut companion differs from the shipped files. Re-run with -Force to replace only that companion directory."
}

Write-Host "Stremio-Kai directory: $KaiDirectory"
Write-Host "AnimeTVCut companion: $destination"
if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source "core.lua") -Destination $destination
Copy-Item -LiteralPath (Join-Path $source "main.lua") -Destination $destination
Copy-Item -LiteralPath (Join-Path $source "fetch_segments.py") -Destination $destination
New-Item -ItemType Directory -Path $optionsDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $optionsDestination)) {
    Copy-Item -LiteralPath $optionsSource -Destination $optionsDestination
} else {
    Write-Host "Existing AnimeTVCut options were preserved: $optionsDestination"
}
Write-Host "AnimeTVCut Stremio-Kai companion installed."
