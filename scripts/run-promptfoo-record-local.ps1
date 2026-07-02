param(
  [ValidateSet('full')]
  [string]$Suite = 'full'
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$serverDir = Join-Path $root 'server'
$configPath = Join-Path $root 'promptfoo\record-full.yaml'
$casesPath = Join-Path $root 'promptfoo\record-cases-100.json'
$reportDir = Join-Path $root 'reports\promptfoo-record'
$resultsJson = Join-Path $reportDir 'record-results.json'
$healthUrl = 'http://127.0.0.1:3001/health'
$serverProcess = $null
$previousEnv = @{
  PORT = $env:PORT
  AI_PROVIDER = $env:AI_PROVIDER
  AI_API_KEY = $env:AI_API_KEY
  AI_BASE_URL = $env:AI_BASE_URL
  AI_MODEL = $env:AI_MODEL
  npm_config_cache = $env:npm_config_cache
  PROMPTFOO_CONFIG_DIR = $env:PROMPTFOO_CONFIG_DIR
  PROMPTFOO_CACHE_PATH = $env:PROMPTFOO_CACHE_PATH
}

function Restore-Env {
  foreach ($key in $previousEnv.Keys) {
    if ($null -eq $previousEnv[$key]) {
      Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$key" -Value $previousEnv[$key]
    }
  }
}

function Get-Health {
  try {
    return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  } catch {
    return $null
  }
}

function Wait-For-Mock-Server {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  for ($index = 0; $index -lt 40; $index += 1) {
    if ($Process.HasExited) {
      $stdout = $Process.StandardOutput.ReadToEnd()
      $stderr = $Process.StandardError.ReadToEnd()
      throw "Local server exited before becoming healthy.`nSTDOUT: $stdout`nSTDERR: $stderr"
    }

    $health = Get-Health
    if ($health -and $health.mode -eq 'mock') {
      return $health
    }

    Start-Sleep -Milliseconds 250
  }

  throw "Timed out waiting for local mock server at $healthUrl."
}

try {
  if (-not (Test-Path $configPath)) {
    throw "Promptfoo config not found: $configPath"
  }
  if (-not (Test-Path $casesPath)) {
    throw "Promptfoo record cases not found: $casesPath"
  }

  $health = Get-Health
  if ($health) {
    if ($health.mode -ne 'mock') {
      throw "Port 3001 is already running in '$($health.mode)' mode. Stop that server before running the free local mock eval."
    }
    Write-Host "Reusing existing local mock server at $healthUrl"
  } else {
    $env:PORT = '3001'
    $env:AI_PROVIDER = 'mock'
    $env:AI_API_KEY = ''
    $env:AI_BASE_URL = ''
    $env:AI_MODEL = ''

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node'
    $startInfo.Arguments = 'src/server.js'
    $startInfo.WorkingDirectory = $serverDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $serverProcess = [System.Diagnostics.Process]::Start($startInfo)

    $health = Wait-For-Mock-Server -Process $serverProcess
    Write-Host "Started local mock server at $healthUrl"
  }

  $promptfooConfigDir = Join-Path $root 'temp\promptfoo\config'
  $promptfooCacheDir = Join-Path $root 'temp\promptfoo\cache'
  New-Item -ItemType Directory -Path $promptfooConfigDir -Force | Out-Null
  New-Item -ItemType Directory -Path $promptfooCacheDir -Force | Out-Null
  New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
  $env:PROMPTFOO_CONFIG_DIR = $promptfooConfigDir
  $env:PROMPTFOO_CACHE_PATH = $promptfooCacheDir

  $promptfoo = Get-Command promptfoo -ErrorAction SilentlyContinue
  $evalArgs = @('eval', '-c', $configPath, '--no-progress-bar', '--table-cell-max-length', '80', '-o', $resultsJson)

  if ($promptfoo) {
    & $promptfoo.Source @evalArgs
  } else {
    Write-Host "Promptfoo command not found; using npm exec --package promptfoo@latest."
    $npmCache = Join-Path $root 'temp\promptfoo\npm-cache'
    New-Item -ItemType Directory -Path $npmCache -Force | Out-Null
    $env:npm_config_cache = $npmCache
    $npmArgs = @('exec', '--yes', '--package', 'promptfoo@latest', '--', 'promptfoo') + $evalArgs
    & npm.cmd @npmArgs
  }

  $promptfooExitCode = $LASTEXITCODE
  if (Test-Path $resultsJson) {
    & node (Join-Path $root 'scripts\build-promptfoo-record-report.js') --input $resultsJson --cases $casesPath --out-dir $reportDir
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }

  if ($promptfooExitCode -ne 0) {
    exit $promptfooExitCode
  }
} finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
  }
  Restore-Env
}
