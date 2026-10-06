# Makes or removes the Start menu and desktop shortcuts of Ash Log. Run by scripts/windows/install.ts
# (npm run app:install), not on its own:
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File shortcuts.ps1 -Action Install
#
# The shortcuts come in as a JSON array in the environment variable ASH_LOG_SHORTCUTS, so paths
# with spaces, quotes or accents need no quoting on the command line. Each one has:
#
#   folder            Programs (the Start menu of this user) or Desktop
#   name              file name without .lnk
#   target            node.exe
#   arguments         --import tsx "...\scripts\windows\launcher.ts" --gui
#   workingDirectory  the project folder
#   icon              ...\scripts\windows\ash-log.ico
#   description       the tooltip
#   windowStyle       7: start minimized
#
# Install writes every shortcut, replacing an older one, and prints its path. Uninstall removes a
# shortcut only while it still starts launcher.ts, so one of the same name that you made yourself
# stays.
#
# ASH_LOG_OBSOLETE_SHORTCUTS (JSON array of folder and name) lists shortcuts of earlier versions.
# Both actions remove those, again only while they still start launcher.ts.
#
# Plain ASCII on purpose: Windows PowerShell 5.1 reads a script without a byte order mark in the
# ANSI code page.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Uninstall')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not $env:ASH_LOG_SHORTCUTS) { throw 'ASH_LOG_SHORTCUTS is missing: run npm run app:install' }
$shortcuts = ConvertFrom-Json -InputObject $env:ASH_LOG_SHORTCUTS
$shell = New-Object -ComObject WScript.Shell

foreach ($shortcut in $shortcuts) {
  # Programs and Desktop follow folder redirection, such as a desktop in OneDrive.
  $folder = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]($shortcut.folder))
  if (-not $folder) { throw "Folder not found: $($shortcut.folder)" }
  $path = Join-Path $folder ($shortcut.name + '.lnk')

  if ($Action -eq 'Install') {
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $shortcut.target
    $link.Arguments = $shortcut.arguments
    $link.WorkingDirectory = $shortcut.workingDirectory
    $link.IconLocation = $shortcut.icon + ',0'
    $link.Description = $shortcut.description
    $link.WindowStyle = [int]($shortcut.windowStyle)
    $link.Save()
    Write-Output "Created: $path"
  } elseif (Test-Path -LiteralPath $path) {
    $link = $shell.CreateShortcut($path)
    if ($link.Arguments -like '*launcher.ts*') {
      Remove-Item -LiteralPath $path -Force
      Write-Output "Removed: $path"
    } else {
      Write-Output "Skipped, it does not start Ash Log: $path"
    }
  }
}

if ($env:ASH_LOG_OBSOLETE_SHORTCUTS) {
  foreach ($old in (ConvertFrom-Json -InputObject $env:ASH_LOG_OBSOLETE_SHORTCUTS)) {
    $folder = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]($old.folder))
    if (-not $folder) { continue }
    $path = Join-Path $folder ($old.name + '.lnk')
    if (Test-Path -LiteralPath $path) {
      $link = $shell.CreateShortcut($path)
      if ($link.Arguments -like '*launcher.ts*') {
        Remove-Item -LiteralPath $path -Force
        Write-Output "Removed old shortcut: $path"
      }
    }
  }
}
