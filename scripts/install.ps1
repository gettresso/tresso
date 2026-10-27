# Install the Tresso desktop app from GitHub releases.
# https://github.com/gettresso/tresso
#
#   powershell -c "irm https://sherin.dev/tresso/install.ps1|iex"
#
# $env:TRESSO_VERSION pins a release (v0.2.0). The installer puts Tresso in %LOCALAPPDATA%\Tresso for this user, adds it
# to the Start menu and makes it the handler of tresso:// links, through which sign-in comes back.
#Requires -Version 5.1

# Everything runs in a script block: piped into iex, an exit, a variable or a changed preference would otherwise reach
# the user's own session.
& {
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 draws a progress bar that slows downloads to a crawl, and older systems offer no TLS 1.2,
# which GitHub requires. Both last only as long as this block, except the TLS setting, which only adds a protocol.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$previousEncoding = [Console]::OutputEncoding

# --- presentation: logo, step lines, and a summary box ---------------------------------------
# The three parts of the Tresso mark (Do, Hand over, Know), in their dark-theme shades so they read on any terminal.
$Stops = @(@(143, 162, 255), @(242, 154, 85), @(108, 199, 178))
$Accent = '143;162;255'
$Tagline = 'Every email is something to do, to hand over, or to know.'
# The file stays ASCII so Windows PowerShell 5.1 reads it correctly without a BOM:
# # = full block, = | a b c d = the double-line box pieces.
$LogoBlock = @(
    '########b######b #######b#######b#######b ######b ',
    'c==##a==d##a==##b##a====d##a====d##a====d##a===##b',
    '   ##|   ######ad#####b  #######b#######b##|   ##|',
    '   ##|   ##a==##b##a==d  c====##|c====##|##|   ##|',
    '   ##|   ##|  ##|#######b#######|#######|c######ad',
    '   c=d   c=d  c=dc======dc======dc======d c=====d '
)
$LogoAscii = @(
    ' _____   ____    _____   ____    ____     ___  ',
    '|_   _| |  _ \  | ____| / ___|  / ___|   / _ \ ',
    '  | |   | |_) | |  _|   \___ \  \___ \  | | | |',
    '  | |   |  _ <  | |___   ___) |  ___) | | |_| |',
    '  |_|   |_| \_\ |_____| |____/  |____/   \___/ '
)

$Esc = [char]27
$Vt = $false
try {
    $Vt = [bool]$Host.UI.SupportsVirtualTerminal
}
catch {
    $Vt = $false
}
if (-not [string]::IsNullOrEmpty($env:WT_SESSION) -or $PSVersionTable.PSVersion.Major -ge 7) {
    $Vt = $true
}
$Color = $Vt -and [string]::IsNullOrEmpty($env:NO_COLOR) -and -not [Console]::IsOutputRedirected
$Unicode = $false
if ($Vt) {
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $Unicode = $true
    }
    catch {
        $Unicode = $false
    }
}
$LogoBlock = $LogoBlock | ForEach-Object {
    $_.Replace('#', [char]0x2588).Replace('=', [char]0x2550).Replace('|', [char]0x2551).Replace('a', [char]0x2554).Replace('b', [char]0x2557).Replace('c', [char]0x255A).Replace('d', [char]0x255D)
}
if ($Unicode) {
    $MarkOk = [string][char]0x2713
    $MarkErr = [string][char]0x2717
    $Box = @([char]0x256D, [char]0x256E, [char]0x2570, [char]0x256F, [char]0x2500, [char]0x2502)
}
else {
    $MarkOk = '+'
    $MarkErr = 'x'
    $Box = @('+', '+', '+', '+', '-', '|')
}

function Format-TressoStyle {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Code
    )
    if (-not $Color -or $Text.Length -eq 0) {
        return $Text
    }
    return "$($Esc)[$($Code)m$Text$($Esc)[0m"
}

function Get-TressoGradient {
    param([int]$Column, [int]$Span, [bool]$Shadow)
    $fraction = $Column / [Math]::Max(1, $Span - 1)
    if ($fraction -lt 0.5) {
        $from = $Stops[0]; $to = $Stops[1]; $local = $fraction * 2
    }
    else {
        $from = $Stops[1]; $to = $Stops[2]; $local = ($fraction - 0.5) * 2
    }
    $rgb = 0..2 | ForEach-Object { [int][Math]::Round($from[$_] + ($to[$_] - $from[$_]) * $local) }
    if ($Shadow) {
        $rgb = $rgb | ForEach-Object { [int][Math]::Round($_ * 0.55) }
        return "22;38;2;$($rgb[0]);$($rgb[1]);$($rgb[2])"
    }
    return "1;38;2;$($rgb[0]);$($rgb[1]);$($rgb[2])"
}

function Write-TressoLogo {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param()
    if ($Unicode) { $rows = $LogoBlock } else { $rows = $LogoAscii }
    $span = $rows[0].Length
    $columns = 80
    try {
        $columns = $Host.UI.RawUI.WindowSize.Width
    }
    catch {
        $columns = 80
    }
    Write-Host ''
    if ($span + 2 -le $columns) {
        foreach ($row in $rows) {
            if (-not $Color) {
                Write-Host "  $($row.TrimEnd())"
                continue
            }
            $builder = New-Object System.Text.StringBuilder
            [void]$builder.Append('  ')
            $last = ''
            for ($i = 0; $i -lt $row.Length; $i++) {
                $ch = $row[$i]
                if ($ch -eq ' ') {
                    [void]$builder.Append(' ')
                    continue
                }
                $code = Get-TressoGradient -Column $i -Span $span -Shadow ($Unicode -and $ch -ne [char]0x2588)
                if ($code -ne $last) {
                    [void]$builder.Append("$($Esc)[$($code)m")
                    $last = $code
                }
                [void]$builder.Append($ch)
            }
            [void]$builder.Append("$($Esc)[0m")
            Write-Host $builder.ToString()
        }
        Write-Host ''
    }
    Write-Host "  $(Format-TressoStyle -Text $Tagline -Code '1')  $(Format-TressoStyle -Text 'installer' -Code '2')"
    Write-Host ''
}

function Write-TressoStep {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Detail
    )
    $mark = Format-TressoStyle -Text $MarkOk -Code '32'
    Write-Host ("  {0} {1} {2}" -f $mark, $Label.PadRight(10), (Format-TressoStyle -Text $Detail -Code '2'))
}

function Write-TressoPending {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param([Parameter(Mandatory = $true)][string]$Label)
    if ($Color) {
        Write-Host -NoNewline ("  {0} {1}" -f (Format-TressoStyle -Text '...' -Code "38;2;$($Accent)"), $Label)
    }
}

function Clear-TressoPending {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param()
    if ($Color) {
        Write-Host -NoNewline "`r$($Esc)[2K"
    }
}

function Write-TressoFailure {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param([Parameter(Mandatory = $true)][string]$Message)
    Clear-TressoPending
    $mark = Format-TressoStyle -Text $MarkErr -Code '1;31'
    Write-Host ("  {0} {1}" -f $mark, (Format-TressoStyle -Text $Message -Code '31'))
}

function Get-TressoDisplayPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $userHome = $env:USERPROFILE
    if (-not [string]::IsNullOrEmpty($userHome) -and $Path.StartsWith($userHome, [StringComparison]::OrdinalIgnoreCase)) {
        return '~' + $Path.Substring($userHome.Length)
    }
    return $Path
}

function Write-TressoSummary {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param([Parameter(Mandatory = $true)][object[]]$Lines)
    # Each line is @(plain, painted).
    $width = ($Lines | ForEach-Object { $_[0].Length } | Measure-Object -Maximum).Maximum
    $columns = 80
    try {
        $columns = $Host.UI.RawUI.WindowSize.Width
    }
    catch {
        $columns = 80
    }
    Write-Host ''
    if ($width + 10 -gt $columns) {
        foreach ($line in $Lines) {
            Write-Host "  $($line[1])"
        }
        Write-Host ''
        return
    }
    $edge = [string]$Box[4] * ($width + 6)
    $side = Format-TressoStyle -Text ([string]$Box[5]) -Code '2'
    Write-Host ('  ' + (Format-TressoStyle -Text ("$($Box[0])$edge$($Box[1])") -Code '2'))
    Write-Host ("  $side" + (' ' * ($width + 6)) + $side)
    foreach ($line in $Lines) {
        Write-Host ("  $side   " + $line[1] + (' ' * ($width - $line[0].Length)) + "   $side")
    }
    Write-Host ("  $side" + (' ' * ($width + 6)) + $side)
    Write-Host ('  ' + (Format-TressoStyle -Text ("$($Box[2])$edge$($Box[3])") -Code '2'))
    Write-Host ''
}

function Get-TressoVersion {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) {
        throw 'empty version'
    }
    if ($Raw -notmatch '^[A-Za-z0-9._-]+$') {
        throw "invalid version: $Raw"
    }
    if ($Raw.StartsWith('v')) {
        return $Raw
    }
    return "v$Raw"
}

function Save-TressoFile {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -ne $curl) {
        & curl.exe -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 --output $Destination $Url
        if ($LASTEXITCODE -ne 0) {
            throw "download failed: $Url"
        }
        return
    }
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

# Where /releases/latest redirects to, with curl.exe when Windows has it and Invoke-WebRequest otherwise.
function Get-TressoLatestUrl {
    param([Parameter(Mandatory = $true)][string]$Url)
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -ne $curl) {
        $effective = & curl.exe -fsSL --proto '=https' --tlsv1.2 -o NUL -w '%{url_effective}' $Url
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($effective)) {
            throw "could not find the latest release at $Url"
        }
        return $effective
    }
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing
    }
    catch {
        throw "could not find the latest release at $Url"
    }
    $final = $response.BaseResponse.ResponseUri
    if ($null -eq $final) {
        $final = $response.BaseResponse.RequestMessage.RequestUri
    }
    return [string]$final
}

function Get-TressoChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$SumsPath,
        [Parameter(Mandatory = $true)][string]$Asset
    )
    foreach ($line in (Get-Content -Path $SumsPath)) {
        if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(\S+)\s*$') {
            if ($Matches[2] -eq $Asset) {
                return $Matches[1].ToLowerInvariant()
            }
        }
    }
    throw "checksum mismatch: SHA256SUMS has no entry for $Asset"
}

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'unsupported platform: install.ps1 is for Windows. Use install.sh on macOS and Linux.'
    }

    $arch = $env:PROCESSOR_ARCHITECTURE
    if (-not [string]::IsNullOrEmpty($env:PROCESSOR_ARCHITEW6432)) {
        $arch = $env:PROCESSOR_ARCHITEW6432
    }
    # Windows on Arm runs the x64 build through its emulation.
    if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') {
        throw "unsupported platform: windows $arch. Tresso publishes Windows x64."
    }

    Write-TressoLogo

    $repo = 'gettresso/tresso'
    $github = "https://github.com/$repo"
    $asset = 'tresso-windows-x64-setup.exe'

    if (-not [string]::IsNullOrWhiteSpace($env:TRESSO_VERSION)) {
        $version = Get-TressoVersion $env:TRESSO_VERSION
    }
    else {
        $latestUrl = "$github/releases/latest"
        $effective = Get-TressoLatestUrl -Url $latestUrl
        if ($effective -notmatch '/releases/tag/([^/?#]+)$') {
            throw "no release published yet at $latestUrl"
        }
        $version = Get-TressoVersion $Matches[1]
    }

    Write-TressoStep -Label 'Version' -Detail $version
    Write-TressoStep -Label 'Platform' -Detail 'windows-x64'

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tresso-install-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    try {
        $setup = Join-Path $tempRoot $asset
        $sums = Join-Path $tempRoot 'SHA256SUMS'
        $base = "$github/releases/download/$version"
        Write-TressoPending -Label "Downloading $asset"
        Save-TressoFile -Url "$base/$asset" -Destination $setup
        Save-TressoFile -Url "$base/SHA256SUMS" -Destination $sums
        Clear-TressoPending
        $size = (Get-Item -Path $setup).Length / 1MB
        Write-TressoStep -Label 'Download' -Detail ("{0} ({1:N1} MB)" -f $asset, $size)

        $expected = Get-TressoChecksum -SumsPath $sums -Asset $asset
        $actual = (Get-FileHash -Algorithm SHA256 -Path $setup).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "checksum mismatch for ${asset}: expected $expected actual $actual"
        }
        Write-TressoStep -Label 'Checksum' -Detail 'SHA-256 matches SHA256SUMS'

        # The setup asks nothing with /S: it installs for this user, replacing an older version in place.
        Write-TressoPending -Label 'Installing'
        $process = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
        Clear-TressoPending
        if ($process.ExitCode -ne 0) {
            throw "the installer stopped with exit code $($process.ExitCode)"
        }
    }
    finally {
        if (Test-Path -Path $tempRoot) {
            Remove-Item -Recurse -Force -Path $tempRoot
        }
    }

    $dest = Join-Path $env:LOCALAPPDATA 'Tresso\tresso-desktop.exe'
    if (-not (Test-Path -Path $dest)) {
        $found = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Tresso') -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike 'uninstall*' } | Select-Object -First 1
        if ($null -eq $found) {
            throw "the installer finished, but Tresso is not in $(Join-Path $env:LOCALAPPDATA 'Tresso')"
        }
        $dest = $found.FullName
    }
    Write-TressoStep -Label 'Installed' -Detail (Get-TressoDisplayPath -Path $dest)
    Write-TressoStep -Label 'Start menu' -Detail 'Tresso, and the handler of tresso:// links'

    $title = "Tresso $($version.TrimStart('v')) is installed"
    $open = Format-TressoStyle -Text 'Tresso' -Code "1;38;2;$($Accent)"
    Write-TressoSummary -Lines @(
        , @("$($MarkOk) $title", "$(Format-TressoStyle -Text $MarkOk -Code '1;32') $(Format-TressoStyle -Text $title -Code '1')")
        , @('', '')
        , @("Location  $(Get-TressoDisplayPath -Path $dest)", "$(Format-TressoStyle -Text 'Location' -Code '2')  $(Get-TressoDisplayPath -Path $dest)")
        , @('Open      Tresso from the Start menu', "$(Format-TressoStyle -Text 'Open' -Code '2')      $open from the Start menu")
        , @('Server    Tresso Cloud, or your own at sign-in', "$(Format-TressoStyle -Text 'Server' -Code '2')    Tresso Cloud, or your own at sign-in")
    )
}
catch {
    Write-TressoFailure -Message $_.Exception.Message
    # A failed install must fail `powershell -c "irm ...|iex"` too, without closing an interactive session.
    throw 'Tresso was not installed.'
}
finally {
    [Console]::OutputEncoding = $previousEncoding
}
}
