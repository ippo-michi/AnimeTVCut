param(
    [Parameter(Mandatory = $true)]
    [string]$KaiDirectory
)

$ErrorActionPreference = "Stop"
$portable = Join-Path $KaiDirectory "portable_config"
$destination = Join-Path $portable "scripts\animetvcut_skip"
$optionsDestination = Join-Path $portable "script-opts\animetvcut_skip.conf"

if (-not (Test-Path -LiteralPath $portable -PathType Container)) {
    throw "The selected directory is not a Stremio-Kai installation (portable_config missing)."
}
if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
if (Test-Path -LiteralPath $optionsDestination) {
    Remove-Item -LiteralPath $optionsDestination -Force
}
Write-Host "AnimeTVCut Stremio-Kai companion removed; native Kai files were untouched."
