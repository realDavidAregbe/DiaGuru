param(
  [string]$CalendarId,
  [string]$SharedSecret,
  [string]$ClearUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$functionsEnvPath = Join-Path $repoRoot "supabase/functions/.env"
$rootEnvPath = Join-Path $repoRoot ".env"

function Get-EnvFileValue {
  param(
    [string]$Path,
    [string[]]$Keys
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  $content = [IO.File]::ReadAllText($Path)
  foreach ($key in $Keys) {
    $match = [regex]::Match($content, "(?m)^$([regex]::Escape($key))=(.*)$")
    if ($match.Success) {
      return $match.Groups[1].Value.Trim()
    }
  }

  return $null
}

function Resolve-Setting {
  param(
    [string[]]$Keys
  )

  foreach ($key in $Keys) {
    $value = [Environment]::GetEnvironmentVariable($key, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }
  }

  $functionsValue = Get-EnvFileValue -Path $functionsEnvPath -Keys $Keys
  if (-not [string]::IsNullOrWhiteSpace($functionsValue)) {
    return $functionsValue
  }

  $rootValue = Get-EnvFileValue -Path $rootEnvPath -Keys $Keys
  if (-not [string]::IsNullOrWhiteSpace($rootValue)) {
    return $rootValue
  }

  return $null
}

function Set-Or-AppendLine {
  param(
    [string]$Path,
    [string]$Key,
    [string]$Value
  )

  $content = if (Test-Path $Path) {
    [IO.File]::ReadAllText($Path)
  } else {
    ""
  }

  $line = "$Key=$Value"
  if ($content -match "(?m)^$([regex]::Escape($Key))=") {
    $updated = [regex]::Replace(
      $content,
      "(?m)^$([regex]::Escape($Key))=.*$",
      [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line }
    )
  } else {
    $updated = $content
    if ($updated.Length -gt 0 -and -not $updated.EndsWith("`n")) {
      $updated += "`n"
    }
    $updated += "$line`n"
  }

  [IO.File]::WriteAllText($Path, $updated)
}

function Remove-Line {
  param(
    [string]$Path,
    [string]$Key
  )

  if (-not (Test-Path $Path)) {
    return
  }

  $content = [IO.File]::ReadAllText($Path)
  $updated = [regex]::Replace($content, "(?m)^$([regex]::Escape($Key))=.*(?:\r?\n)?", "")
  [IO.File]::WriteAllText($Path, $updated)
}

$resolvedCalendarId = if (-not [string]::IsNullOrWhiteSpace($CalendarId)) {
  $CalendarId.Trim()
} else {
  Resolve-Setting -Keys @("BENCHMARK_GOOGLE_CALENDAR_ID")
}

$resolvedSecret = if (-not [string]::IsNullOrWhiteSpace($SharedSecret)) {
  $SharedSecret.Trim()
} else {
  Resolve-Setting -Keys @("BENCHMARK_SHARED_SECRET")
}

$resolvedClearUrl = if (-not [string]::IsNullOrWhiteSpace($ClearUrl)) {
  $ClearUrl.Trim()
} else {
  Resolve-Setting -Keys @("BENCHMARK_CLEAR_URL")
}

if ([string]::IsNullOrWhiteSpace($resolvedCalendarId)) {
  $resolvedCalendarId = Read-Host "Benchmark Google Calendar ID"
}

if ([string]::IsNullOrWhiteSpace($resolvedSecret)) {
  $resolvedSecret = Read-Host "Benchmark shared secret"
}

if ([string]::IsNullOrWhiteSpace($resolvedCalendarId)) {
  throw "Benchmark Google Calendar ID is required."
}

if ([string]::IsNullOrWhiteSpace($resolvedSecret)) {
  throw "Benchmark shared secret is required."
}

Set-Or-AppendLine -Path $functionsEnvPath -Key "BENCHMARK_GOOGLE_CALENDAR_ID" -Value $resolvedCalendarId
Set-Or-AppendLine -Path $functionsEnvPath -Key "BENCHMARK_SHARED_SECRET" -Value $resolvedSecret
Set-Or-AppendLine -Path $rootEnvPath -Key "BENCHMARK_GOOGLE_CALENDAR_ID" -Value $resolvedCalendarId
Set-Or-AppendLine -Path $rootEnvPath -Key "BENCHMARK_SHARED_SECRET" -Value $resolvedSecret

if (-not [string]::IsNullOrWhiteSpace($resolvedClearUrl)) {
  Set-Or-AppendLine -Path $functionsEnvPath -Key "BENCHMARK_CLEAR_URL" -Value $resolvedClearUrl
  Set-Or-AppendLine -Path $rootEnvPath -Key "BENCHMARK_CLEAR_URL" -Value $resolvedClearUrl
} else {
  Remove-Line -Path $functionsEnvPath -Key "BENCHMARK_CLEAR_URL"
  Remove-Line -Path $rootEnvPath -Key "BENCHMARK_CLEAR_URL"
}

& supabase secrets set `
  "BENCHMARK_GOOGLE_CALENDAR_ID=$resolvedCalendarId" `
  "BENCHMARK_SHARED_SECRET=$resolvedSecret" `
  @(
    if (-not [string]::IsNullOrWhiteSpace($resolvedClearUrl)) {
      "BENCHMARK_CLEAR_URL=$resolvedClearUrl"
    }
  )

Write-Host "Benchmark calendar configuration synced."
Write-Host "Calendar ID: $resolvedCalendarId"
if (-not [string]::IsNullOrWhiteSpace($resolvedClearUrl)) {
  Write-Host "Clear hook: configured"
} else {
  Write-Host "Clear hook: not configured"
}
