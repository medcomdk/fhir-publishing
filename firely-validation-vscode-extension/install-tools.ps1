$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2

# Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$dataHome = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $HOME 'AppData\Local'
} else {
    $env:LOCALAPPDATA
}
$installRoot = Join-Path $dataHome 'medcom-firely-validation'
$binDir = Join-Path $installRoot 'bin'
$dotnetDir = Join-Path $installRoot 'dotnet'
$nodeDir = Join-Path $installRoot 'node'
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("medcom-firely-validation-" + [Guid]::NewGuid().ToString('N'))

function Write-Step([string] $Message) {
    Write-Host "==> $Message"
}

function Invoke-Download([string] $Url, [string] $Destination, [string] $Description) {
    Write-Step "Downloading $Description. This can take several minutes..."
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    $sizeMb = [Math]::Round((Get-Item -LiteralPath $Destination).Length / 1MB, 1)
    Write-Step "Downloaded $Description ($sizeMb MB)."
}

function Invoke-Checked([string] $Command, [string[]] $Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command"
    }
}

function Expand-Zip([string] $Archive, [string] $Destination, [string] $Description) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($null -ne $tar) {
        Write-Step "Extracting $Description with the Windows native extractor..."
        Invoke-Checked $tar.Source @('-xf', $Archive, '-C', $Destination)
    } else {
        Write-Step "Extracting $Description with the .NET ZIP extractor..."
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
    }
    $stopwatch.Stop()
    Write-Step "Extracted $Description in $([Math]::Round($stopwatch.Elapsed.TotalSeconds, 1)) seconds."
}

function Test-Dotnet8 {
    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $false
    }
    $sdks = & $command.Source --list-sdks 2>$null
    return $LASTEXITCODE -eq 0 -and $null -ne ($sdks | Select-String -Pattern '^8\.')
}

$machineArchitecture = if ([string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
    $env:PROCESSOR_ARCHITECTURE
} else {
    $env:PROCESSOR_ARCHITEW6432
}
$architecture = switch ($machineArchitecture) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported Windows architecture: $machineArchitecture" }
}

New-Item -ItemType Directory -Force -Path $binDir, $installRoot, $tempDir | Out-Null
$env:PATH = "$binDir;$nodeDir;$dotnetDir;$env:PATH"

try {
    Write-Step "Checking validation tools for Windows $architecture..."
    if (-not (Test-Dotnet8)) {
        Write-Step '.NET SDK 8 was not found.'
        $dotnetArchive = Join-Path $tempDir 'dotnet-sdk.zip'
        Invoke-Download "https://aka.ms/dotnet/8.0/dotnet-sdk-win-$architecture.zip" $dotnetArchive '.NET SDK 8'
        $dotnetExtractDir = Join-Path $tempDir 'dotnet-extracted'
        Expand-Zip $dotnetArchive $dotnetExtractDir '.NET SDK 8'
        if (Test-Path $dotnetDir) {
            Remove-Item -LiteralPath $dotnetDir -Recurse -Force
        }
        Move-Item -LiteralPath $dotnetExtractDir -Destination $dotnetDir
        Write-Step "Installed .NET SDK 8 in $dotnetDir."
    } else {
        Write-Step '.NET SDK 8 is available.'
    }

    if (Test-Path (Join-Path $dotnetDir 'dotnet.exe')) {
        $env:DOTNET_ROOT = $dotnetDir
    }

    if ($null -eq (Get-Command fhir -ErrorAction SilentlyContinue)) {
        Write-Step 'Installing Firely Terminal...'
        Invoke-Checked 'dotnet' @('tool', 'install', 'Firely.Terminal', '--tool-path', $binDir)
    } else {
        Write-Step 'Firely Terminal is available.'
    }

    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Step 'Node.js and npm were not found.'
        $nodeUrl = 'https://nodejs.org/dist/latest-v24.x'
        $checksumFile = Join-Path $tempDir 'SHASUMS256.txt'
        Invoke-Download "$nodeUrl/SHASUMS256.txt" $checksumFile 'Node.js checksums'

        $nodeArchiveName = $null
        $expectedHash = $null
        foreach ($line in Get-Content -LiteralPath $checksumFile) {
            $pattern = '^([0-9a-fA-F]{64})\s+\*?(node-v[^\s]+-win-' + [regex]::Escape($architecture) + '\.zip)$'
            if ($line -match $pattern) {
                $expectedHash = $Matches[1]
                $nodeArchiveName = $Matches[2]
                break
            }
        }
        if ($null -eq $nodeArchiveName) {
            throw "No Node.js download is available for Windows $architecture."
        }

        $nodeArchive = Join-Path $tempDir $nodeArchiveName
        Invoke-Download "$nodeUrl/$nodeArchiveName" $nodeArchive 'Node.js'
        Write-Step 'Verifying the Node.js download...'
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash
        if ($actualHash -ne $expectedHash) {
            throw 'The downloaded Node.js archive failed its SHA-256 checksum.'
        }

        $extractDir = Join-Path $tempDir 'node'
        Expand-Zip $nodeArchive $extractDir 'Node.js and npm'
        $extractedRoot = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if ($null -eq $extractedRoot) {
            throw 'The downloaded Node.js archive did not contain the expected directory.'
        }
        if (Test-Path $nodeDir) {
            Remove-Item -LiteralPath $nodeDir -Recurse -Force
        }
        Move-Item -LiteralPath $extractedRoot.FullName -Destination $nodeDir
        Write-Step "Installed Node.js and npm in $nodeDir."
    } else {
        Write-Step 'Node.js and npm are available.'
    }

    if ($null -eq (Get-Command sushi -ErrorAction SilentlyContinue)) {
        Write-Step 'Installing SUSHI...'
        $npm = (Get-Command npm -ErrorAction Stop).Source
        Invoke-Checked $npm @('install', '--global', '--prefix', $binDir, '--no-audit', '--no-fund', 'fsh-sushi')
    } else {
        Write-Step 'SUSHI is available.'
    }

    Write-Step 'Verifying tool versions...'
    Invoke-Checked 'dotnet' @('--list-sdks')
    Invoke-Checked 'fhir' @('--version')
    Invoke-Checked ((Get-Command npm -ErrorAction Stop).Source) @('--version')
    Invoke-Checked ((Get-Command sushi -ErrorAction Stop).Source) @('--version')
    Write-Step 'Firely validation tools are ready.'
} finally {
    if (Test-Path $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}
