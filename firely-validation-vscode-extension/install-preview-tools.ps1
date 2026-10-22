param([Parameter(Mandatory = $true)][string] $InstallRoot)

# Independent of install-tools.ps1: only Ruby, its DevKit and preview gems.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2
$gemHome = Join-Path $InstallRoot 'gems'
$rubyDir = Join-Path $InstallRoot 'ruby'
$binDir = Join-Path $InstallRoot 'bin'
$launcher = Join-Path $binDir 'jekyll.cmd'
$candidate = Join-Path $binDir ('.jekyll-' + [Guid]::NewGuid().ToString('N') + '.cmd')

function Invoke-Checked([string] $Command, [string[]] $Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit ${LASTEXITCODE}): $Command" }
}

function Test-Ruby([string] $Executable) {
    if (-not (Test-Path -LiteralPath $Executable)) { return $false }
    & $Executable -rrubygems -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new(%q{3.1}) ? 0 : 1)'
    return $LASTEXITCODE -eq 0
}

if (Test-Path -LiteralPath $launcher) {
    & $launcher --version
    if ($LASTEXITCODE -eq 0) { Write-Host 'Preview dependencies are ready.'; exit 0 }
}

$rubyExecutable = Join-Path $rubyDir 'bin\ruby.exe'
if (-not (Test-Ruby $rubyExecutable)) {
    $ruby = Get-Command ruby.exe -ErrorAction SilentlyContinue
    if ($null -ne $ruby -and (Test-Ruby $ruby.Source)) { $rubyExecutable = $ruby.Source }
}
if (-not (Test-Ruby $rubyExecutable)) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        throw 'Automatic Ruby installation requires Windows App Installer (winget). Install it, or Ruby+Devkit 3.1+ from https://rubyinstaller.org, then retry preview.'
    }
    Write-Host 'Installing Ruby+Devkit for the current user...'
    # WinGet verifies the RubyInstaller download against its package manifest.
    $overrides = '/VERYSILENT /CURRENTUSER /SUPPRESSMSGBOXES /NORESTART /TASKS="noassocfiles,nomodpath,noridkinstall" /DIR="' + $rubyDir + '"'
    Invoke-Checked $winget.Source @(
        'install', '--id', 'RubyInstallerTeam.RubyWithDevKit.3.4', '--exact', '--source', 'winget',
        '--scope', 'user', '--accept-source-agreements', '--accept-package-agreements',
        '--disable-interactivity', '--override', $overrides
    )
    $rubyExecutable = Join-Path $rubyDir 'bin\ruby.exe'
    if (-not (Test-Ruby $rubyExecutable)) { throw "Ruby was not installed in $rubyDir. See the installer output." }
}
$rubyBin = Split-Path -Parent $rubyExecutable
$env:PATH = "$rubyBin;$env:PATH"
$ridk = Join-Path $rubyBin 'ridk.cmd'
if (-not (Test-Path -LiteralPath $ridk)) {
    throw 'Jekyll requires Ruby+Devkit on Windows. Install it from https://rubyinstaller.org, then retry preview.'
}
Write-Host 'Preparing the Ruby MSYS2 development toolchain...'
Invoke-Checked $ridk @('install', '1', '3')

New-Item -ItemType Directory -Force -Path $gemHome, $binDir | Out-Null
$env:GEM_HOME = $gemHome
$env:GEM_PATH = $gemHome
try {
    Write-Host "Installing Jekyll gems in $gemHome..."
    $gemOptions = @('-rrubygems/gem_runner', '-e', 'Gem::GemRunner.new.run(ARGV)', '--', 'install', '--norc', '--clear-sources', '--source', 'https://rubygems.org', '--install-dir', $gemHome, '--bindir', (Join-Path $gemHome 'bin'), '--no-document')
    Invoke-Checked $rubyExecutable ($gemOptions + @('jekyll', '--version', '4.4.1'))
    Invoke-Checked $rubyExecutable ($gemOptions + @('bundler', '--version', '~> 2.6.0'))
    Invoke-Checked $rubyExecutable ($gemOptions + @('tzinfo-data'))
    # Escape percent signs in batch literals; delayed expansion stays disabled for !.
    $escapedGems = $gemHome.Replace('%', '%%')
    $escapedRuby = $rubyExecutable.Replace('%', '%%')
    $escapedRubyBin = $rubyBin.Replace('%', '%%')
    $content = @"
@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "GEM_HOME=$escapedGems"
set "GEM_PATH=$escapedGems"
set "PATH=$escapedRubyBin;%PATH%"
"$escapedRuby" "$escapedGems\bin\jekyll" %*
exit /b %errorlevel%
"@
    [IO.File]::WriteAllText($candidate, $content, (New-Object Text.UTF8Encoding($false)))
    Invoke-Checked $candidate @('--version')
    Move-Item -LiteralPath $candidate -Destination $launcher -Force
    Write-Host 'Preview dependencies are ready.'
} finally {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
}
