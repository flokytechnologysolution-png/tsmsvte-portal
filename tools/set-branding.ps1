<#
  tools/set-branding.ps1 — upload the Taraba State Seal as the site logo and
  push the branding settings to a running portal.

  Fixes over the original ad-hoc script:
    1. CSRF handshake — the portal requires the tsmsvte_csrf cookie echoed in
       the x-csrf-token header on every /api write (middleware/csrf.js), so we
       fetch /api/auth/csrf first with a cookie jar.
    2. Uses curl.exe for the multipart upload — Windows PowerShell 5.1 has no
       -Form parameter on Invoke-RestMethod.
    3. Points at the real seal image instead of the placeholder logo.
    4. Reports keys the server rejected and verifies the result afterwards.

  Usage:
    $env:TSMSVTE_TOKEN = '<owner JWT>'     # from a logged-in session
    .\tools\set-branding.ps1               # against the default base URL
    .\tools\set-branding.ps1 -BaseUrl http://127.0.0.1:3000 -SealPath .\seal.webp
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://tsmsvte-portal.onrender.com',
  [string]$SealPath = (Join-Path $env:USERPROFILE 'Downloads\Seal-of-Taraba-State.webp'),
  # No governor photo ships with the repo; when one is supplied it is uploaded,
  # otherwise the existing /img/photos/governor.svg placeholder is kept.
  [string]$GovernorPhotoPath = ''
)

$ErrorActionPreference = 'Stop'
$token = $env:TSMSVTE_TOKEN
if (-not $token) { throw 'Set TSMSVTE_TOKEN to an OWNER/ADMIN JWT first.' }
$BaseUrl = $BaseUrl.TrimEnd('/')

if (-not (Test-Path $SealPath)) { throw "Seal image not found: $SealPath" }
$sealExt = [IO.Path]::GetExtension($SealPath).ToLower()
if ($sealExt -notin '.jpg', '.jpeg', '.png', '.webp') {
  throw "The upload endpoint only accepts .jpg/.jpeg/.png/.webp (got $sealExt)."
}

function Read-Json([string]$text) {
  try { return $text | ConvertFrom-Json } catch { return $null }
}

if ($sealExt -in '.jpg', '.jpeg') { $sealMime = 'image/jpeg' }
elseif ($sealExt -eq '.png') { $sealMime = 'image/png' }
else { $sealMime = 'image/webp' }

Write-Host "== Branding setup for $BaseUrl ==" -ForegroundColor Cyan

# --- 1. CSRF handshake: fetch a cookie jar + token -------------------------
$jar = Join-Path $env:TEMP ('tsmsvte-csrf-' + [Guid]::NewGuid().ToString('N') + '.txt')
$csrfRaw = (& curl.exe -s -S -c $jar "$BaseUrl/api/auth/csrf") -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Could not reach $BaseUrl/api/auth/csrf" }
$csrf = (Read-Json $csrfRaw).csrfToken
if (-not $csrf) { throw "No CSRF token in response: $csrfRaw" }
Write-Host "CSRF token acquired." -ForegroundColor DarkGray

$apiHeaders = @{
  'Authorization' = "Bearer $token"
  'x-csrf-token'  = $csrf
}

# --- 2. Upload the state seal as the logo ----------------------------------
Write-Host "Uploading state seal ($SealPath)..." -ForegroundColor Yellow
$sealArgs = @(
  '-s', '-S',
  '-b', $jar,
  '-H', "Authorization: Bearer $token",
  '-H', "x-csrf-token: $csrf",
  '-F', "file=@$SealPath;type=$sealMime",
  '-o', '-', '-w', '|%{http_code}',
  "$BaseUrl/api/settings/upload"
)
$sealRaw = (& curl.exe @sealArgs) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Upload request failed (network).' }
$sealParts = $sealRaw -split '\|(?=\d{3}$)', 2
$sealBody = Read-Json $sealParts[0]
$sealCode = if ($sealParts.Count -gt 1) { $sealParts[1] } else { '?' }
if ($sealCode -ne '200' -or -not $sealBody.url) {
  throw "Seal upload failed (HTTP $sealCode): $($sealParts[0])"
}
$logoUrl = $sealBody.url
Write-Host "Seal uploaded: $logoUrl" -ForegroundColor Green

# --- 3. Optional governor photo --------------------------------------------
$governorUrl = '/img/photos/governor.svg'   # current default placeholder
if ($GovernorPhotoPath -and (Test-Path $GovernorPhotoPath)) {
  $govExt = [IO.Path]::GetExtension($GovernorPhotoPath).ToLower()
  $govMime = if ($govExt -in '.jpg', '.jpeg') { 'image/jpeg' } elseif ($govExt -eq '.png') { 'image/png' } else { 'image/webp' }
  Write-Host "Uploading governor photo ($GovernorPhotoPath)..." -ForegroundColor Yellow
  $govRaw = (& curl.exe -s -S -b $jar `
    -H "Authorization: Bearer $token" -H "x-csrf-token: $csrf" `
    -F "file=@$GovernorPhotoPath;type=$govMime" -o - -w '|%{http_code}' "$BaseUrl/api/settings/upload") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Governor photo upload request failed (network).' }
  $govParts = $govRaw -split '\|(?=\d{3}$)', 2
  $govBody = Read-Json $govParts[0]
  $govCode = if ($govParts.Count -gt 1) { $govParts[1] } else { '?' }
  if ($govCode -eq '200' -and $govBody.url) {
    $governorUrl = $govBody.url
    Write-Host "Governor photo uploaded: $governorUrl" -ForegroundColor Green
  } else {
    Write-Host "Governor photo upload failed (HTTP $govCode) - keeping placeholder." -ForegroundColor Red
    Write-Host "  $($govParts[0])" -ForegroundColor Red
  }
} else {
  Write-Host "No governor photo supplied - keeping the placeholder." -ForegroundColor Yellow
}

# --- 4. Update site settings ------------------------------------------------
$settingsPayload = @{
  logo                = $logoUrl
  governor_photo      = $governorUrl
  governor_name       = 'His Excellency, Dr. Agbu Kefas'
  governor_title      = 'Executive Governor, Taraba State'
  commissioner_name   = 'Dr. Augustina Godwin'
  commissioner_title  = 'Honourable Commissioner, Ministry of Secondary, Technical and Vocational Education'
  ministry_name       = 'Taraba State Ministry of Secondary, Vocational and Technical Education'
  primary_color       = '#0b6b3a'
  accent_color        = '#f2b705'
} | ConvertTo-Json

Write-Host "Updating site settings..." -ForegroundColor Cyan
# The CSRF guard needs the cookie AND the header, so this rides the same jar.
#
# NEVER pass the JSON on the command line.  PowerShell splits a multi-word
# string into separate curl arguments, so curl ends up parsing the payload as
# a list of URLs ("curl: (6) Could not resolve host: Augustina").  Instead
# write it to a UTF-8 file with no BOM and let curl read it with
# --data-binary @file, which posts the bytes untouched.
$payloadFile = Join-Path $env:TEMP ('tsmsvte-settings-' + [Guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($payloadFile, $settingsPayload, (New-Object Text.UTF8Encoding($false)))
$setRaw = (& curl.exe -s -S -X PUT -b $jar `
  -H "Authorization: Bearer $token" -H "x-csrf-token: $csrf" `
  -H 'Content-Type: application/json' --data-binary "@$payloadFile" `
  -o - -w '|%{http_code}' "$BaseUrl/api/settings") -join "`n"
$setParts = $setRaw -split '\|(?=\d{3}$)', 2
$setBody = Read-Json $setParts[0]
$setCode = if ($setParts.Count -gt 1) { $setParts[1] } else { '?' }
if ($setCode -eq '200' -and $setBody) {
  Write-Host ("Settings updated: {0}" -f ($setBody.updated -join ', ')) -ForegroundColor Green
  if ($setBody.rejected -and $setBody.rejected.Count) {
    Write-Host ("Rejected by server: {0}" -f ($setBody.rejected -join ', ')) -ForegroundColor Red
  }
} else {
  Write-Host "Failed to update settings (HTTP $setCode): $($setParts[0])" -ForegroundColor Red
}

# --- 5. Verify ---------------------------------------------------------------
# Values are checked by actually fetching them: a stored path is only good if
# the site can serve it.  The live DB had 'public/icons/logo-192.png' and
# 'public/img/photos/governor.jpg' — truthy strings that 404, because static
# files are served from public/ already.  Those look fine to a truthiness check
# and broken in the browser, so prove them with a request instead.
function Test-ImageUrl([string]$value, [string]$label) {
  if (-not $value) {
    Write-Host ("  MISS  {0} = (empty)" -f $label) -ForegroundColor Red
    return
  }
  $abs = if ($value -match '^https?://') { $value } else { $BaseUrl + $(if ($value -like '/*') { $value } else { "/$value" }) }
  try {
    $code = (Invoke-WebRequest -Uri $abs -Method Head -UseBasicParsing).StatusCode
    if ($code -eq 200) {
      Write-Host ("  ok    {0} = {1}" -f $label, $value) -ForegroundColor Green
    } else {
      Write-Host ("  BAD   {0} = {1}  (HTTP {2})" -f $label, $value, $code) -ForegroundColor Red
    }
  } catch {
    $code = try { $_.Exception.Response.StatusCode.value__ } catch { 'network error' }
    Write-Host ("  BAD   {0} = {1}  ({2})" -f $label, $value, $code) -ForegroundColor Red
  }
}

Write-Host "Verifying public settings..." -ForegroundColor Cyan
try {
  $pub = (Invoke-RestMethod -Uri "$BaseUrl/api/settings/public").settings
  @('governor_name', 'commissioner_name', 'commissioner_title', 'ministry_name', 'primary_color', 'accent_color') |
    ForEach-Object {
      $v = $pub.$_
      $bad = -not $v -or $v -like '*PLACEHOLDER*'
      Write-Host ("  {0}  {1} = {2}" -f $(if ($bad) { 'MISS' } else { 'ok  ' }), $_, $v) -ForegroundColor $(if ($bad) { 'Red' } else { 'Green' })
    }
  Test-ImageUrl $pub.logo 'logo'
  Test-ImageUrl $pub.governor_photo 'governor_photo'
} catch {
  Write-Host "Verification failed: $($_.Exception.Message)" -ForegroundColor Red
}

Remove-Item $jar, $payloadFile -ErrorAction SilentlyContinue
Write-Host "Done. Refresh the site to see the changes." -ForegroundColor Magenta
