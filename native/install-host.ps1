# Compatibility entry point for the verified, non-destructive updater.
param([switch]$DryRun, [string]$BackupDirectory = '')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-update.ps1') -DryRun:$DryRun -BackupDirectory $BackupDirectory