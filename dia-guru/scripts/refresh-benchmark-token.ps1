param(
  [string]$Email
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

function Read-PlainPassword {
  $secure = Read-Host "Supabase password" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
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

$supabaseUrl = Resolve-Setting -Keys @("SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL")
$anonKey = Resolve-Setting -Keys @("SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY")
$resolvedEmail = if (-not [string]::IsNullOrWhiteSpace($Email)) {
  $Email.Trim()
} else {
  Resolve-Setting -Keys @("TEST_EMAIL")
}

if ([string]::IsNullOrWhiteSpace($supabaseUrl)) {
  throw "Missing SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL."
}

if ([string]::IsNullOrWhiteSpace($anonKey)) {
  throw "Missing SUPABASE_ANON_KEY / EXPO_PUBLIC_SUPABASE_ANON_KEY."
}

if ([string]::IsNullOrWhiteSpace($resolvedEmail)) {
  $resolvedEmail = Read-Host "Supabase email"
}

if ([string]::IsNullOrWhiteSpace($resolvedEmail)) {
  throw "Email is required."
}

$password = Resolve-Setting -Keys @("TEST_PASSWORD")
if ([string]::IsNullOrWhiteSpace($password)) {
  $password = Read-PlainPassword
}

if ([string]::IsNullOrWhiteSpace($password)) {
  throw "Password is required."
}

$env:SUPABASE_URL = $supabaseUrl
$env:SUPABASE_ANON_KEY = $anonKey
$env:TEST_EMAIL = $resolvedEmail
$env:TEST_PASSWORD = $password

$sessionJson = node -e "const { createClient } = require('@supabase/supabase-js'); const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY); (async () => { const { data, error } = await client.auth.signInWithPassword({ email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD }); if (error) { console.error(error.message); process.exit(1); } process.stdout.write(JSON.stringify({ accessToken: data.session.access_token, expiresAt: data.session.expires_at, userId: data.user.id, email: data.user.email })); })();"

if ([string]::IsNullOrWhiteSpace($sessionJson)) {
  throw "Failed to refresh USER_BEARER."
}

$session = $sessionJson | ConvertFrom-Json

Set-Or-AppendLine -Path $functionsEnvPath -Key "USER_BEARER" -Value $session.accessToken
Set-Or-AppendLine -Path $functionsEnvPath -Key "USER_ID" -Value $session.userId
Set-Or-AppendLine -Path $rootEnvPath -Key "USER_BEARER" -Value $session.accessToken
Set-Or-AppendLine -Path $rootEnvPath -Key "USER_ID" -Value $session.userId

$expiry = [DateTimeOffset]::FromUnixTimeSeconds([int64]$session.expiresAt).ToLocalTime()
Write-Host "Benchmark token refreshed for $($session.email)."
Write-Host "Updated USER_BEARER in supabase/functions/.env and .env."
Write-Host "Token expires at $($expiry.ToString('yyyy-MM-dd HH:mm:ss zzz'))."
