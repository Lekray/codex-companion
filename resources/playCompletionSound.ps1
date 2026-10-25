param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        [Console]::Error.WriteLine('Completion sound file was not found.')
        exit 2
    }
    $player = New-Object System.Media.SoundPlayer -ArgumentList $fullPath
    $player.Load()
    $player.PlaySync()
    exit 0
}
catch {
    [Console]::Error.WriteLine('Completion sound could not be played.')
    exit 1
}
