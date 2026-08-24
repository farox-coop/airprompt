# airprompt — installer shim (Windows / PowerShell, adapted from caveman's install.ps1).
#
# Thin wrapper around bin/install.js (the unified Node installer). Every flag
# you'd pass to bin/install.js can be passed here; we just forward them.
#
# One-line install:
#   irm https://raw.githubusercontent.com/farox-coop/airprompt/main/install.ps1 | iex
#
# Local clone:
#   pwsh install.ps1 [flags]
#
# Why a Node installer? install.sh + install.ps1 used to be parallel sources of
# truth and constantly drifted. One Node script works everywhere without
# PowerShell quoting bugs.
#
# Why no top-level param() and everything inside a function? `irm | iex`
# executes this file as a string: script-path variables ($PSCommandPath,
# $MyInvocation.MyCommand.Path) are $null and a top-level param block cannot
# receive arguments through a pipe anyway (issue #565). Wrapping the logic in
# a function and forwarding $args keeps one script working for both the pipe
# path (no args, no script path) and the local-clone path.

function Install-AirPrompt {
  param(
    [string[]]$InstallerArgs = @()
  )

  $ErrorActionPreference = "Stop"
  $Repo = "farox-coop/airprompt"

  # Require Node ≥20.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error @"
airprompt: Node.js (>=20) required. Install:
  - winget install OpenJS.NodeJS.LTS
  - or download from https://nodejs.org
"@
    exit 1
  }

  $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 18) {
    Write-Error "airprompt: Node $nodeMajor too old. Need Node >=20. Upgrade: https://nodejs.org"
    exit 1
  }

  # If we're inside the repo clone, run the local installer directly.
  if ($PSCommandPath) {
    $here = Split-Path -Parent $PSCommandPath
    $local = Join-Path $here "bin/install.js"
    if (Test-Path $local) {
      & node $local @InstallerArgs
      exit $LASTEXITCODE
    }
  }

  # Curl-pipe path: shallow clone then exec installer.
  # We can't use npx like caveman does — airprompt has runtime npm deps
  # (express, ws, node-pty, qrcode-terminal) that npx won't install.
  # Clone + let bin/install.js handle npm install.
  $tmp = Join-Path $env:TEMP "airprompt-install-$(Get-Random)"
  git clone --depth 1 "https://github.com/$Repo.git" $tmp 2>$null
  & node "$tmp/bin/install.js" @InstallerArgs
  $exitCode = $LASTEXITCODE
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  exit $exitCode
}

# $args is the automatic variable: populated when run as a file
# (`pwsh install.ps1 --force`), empty under `irm | iex`.
Install-AirPrompt -InstallerArgs $args
