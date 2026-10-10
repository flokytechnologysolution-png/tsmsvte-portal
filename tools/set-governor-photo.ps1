<#
  tools/set-governor-photo.ps1 -- publish a VERIFIED portrait of the Executive
  Governor as a durable asset and point the governor_photo setting at it.

  Why this differs from the naive "upload to /api/settings/upload" approach:

    1. Durability -- /uploads/* lives on Render's ephemeral container filesystem
       and is wiped on the next deploy.  We instead stage the photo as a
       COMMITTED static asset under public/img/photos/ (the same technique used
       for the state seal), so it survives redeploys.
    2. CSRF -- the portal requires the tsmsvte_csrf cookie echoed in the
       x-csrf-token header on every /api write.  Invoke-RestMethod -Body does
       NOT ride the cookie jar and returns 403; we use curl.exe with the
       handshake, exactly like tools/set-branding.ps1.
    3. Verification -- every URL is proven with a real request, never a
       truthiness check, so a 404 is reported instead of silently trusted.

  Usage:
    .\tools\set-governor-photo.ps1 -PhotoPath 'C:\path\to\governor.jpg'
    .\tools\set-governor-photo.ps1 -PhotoPath .\governor.webp -Commit -Push
    .\tools\set-governor-photo.ps1 -PhotoPath .\governor.png -BaseUrl http://127.0.0.1:3000 -NoWait
#>
[CmdletBssinding()]
param(
  [Parameter(Mandatory = $true)][string]$PhotoPath,
  [string]$BaseUrl = 'https://tsmsvte-portal.onrender.com',
  [string]$AssetName = 'governor',      # -> public/img/photos/<AssetName>.<ext>
  [switch]$Commit,
  [switch]$Push,
  [switch]$NoWait,
  [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$repoRoot = Split-Path -Parent $PSScriptRoot
$photosDir = Join-Path $repoRoot 'public\img\photos'

function Read-Json([string]$text) { try { return $text | ConvertFrom-Json } catch { return $null } }

# --- 1. Validate the source image ------------------------------------------
if (-not (Test-Path $PhotoPath)) { throw "Photo not found: $PhotoPath" }
$srcItem = Get-Item $PhotoPath
$ext = [IO.Path]::GetExtension($PhotoPath).ToLower()
$allowed = '.jpg', '.jpeg', '.png', '.webp'
if ($allowed -notcontains $ext) { throw "Unsupported type '$ext'. Allowed: $($allowed -join ', ')" }
$maxBytes = 3MB   # matches the images uploader limit in middleware/upload.js
if ($srcItem.Length -gt $maxBytes) {
  throw ("Photo is {0:N0} bytes; the branding image limit is {1:N0} bytes (3 MB)." -f $srcItem.Length, $maxBytes)
}
Write-Host ("Source: {0}  ({1:N0} KB, {2})" -f $srcItem.FullName, ($srcItem.Length / 1KB), $ext) -ForegroundColor DarkGray

# --- 2. Stage as a durable committed asset ---------------------------------
if (-not (Test-Path $photosDir)) { New-Item -ItemType Directory -Path $photosDir -Force | Out-Null }
$assetFile = Join-Path $photosDir ($AssetName + $ext)
Copy-Item -LiteralPath $srcItem.FullName -Destination $assetFile -Force
$assetUrl = "/img/photos/$AssetName$ext"
Write-Host ("Staged durable asset: {0}" -f $assetFile) -ForegroundColor Cyan
Write-Host ("Served at: {0}{1}" -f $BaseUrl, $assetUrl) -ForegroundColor DarkGray

# --- 3. Optional: commit + push (this triggers the Render redeploy) --------
if ($Commit) {
  Write-Host "Committing asset..." -ForegroundColor Cyan
  # Use the absolute path: Resolve-Path -Relative would resolve against the
  # shell's CWD, not the repo root, producing a pathspec git cannot match.
  & git -C $repoRoot add -- $assetFile 2>&1 | Out-Null
  & git -C $repoRoot commit -m "Add Governor portrait as durable branding asset" 2>&1 |
    Select-Object -Last 1 | ForEach-Object { Write-Host $_ }
}
if ($Push) {
  Write-Host "Pushing to origin (deploy will start)..." -ForegroundColor Cyan
  # git writes normal progress ("To https://...") to stderr.  Under
  # $ErrorActionPreference='Stop' that surfaces as a terminating
  # NativeCommandError and aborts the script even on success.  Capture it and
  # judge success by the exit code instead.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $pushOut = & git -C $repoRoot push origin HEAD 2>&1
  $pushCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $pushOut | Select-Object -Last 1 | ForEach-Object { Write-Host $_ }
  if ($pushCode -ne 0) { throw "git push failed (exit $pushCode)" }
  Write-Host "Pushed." -ForegroundColor DarkGray
}

# --- 4. Wait for the deploy to actually serve the asset --------------------
if (-not $NoWait) {
  Write-Host "Waiting for the asset to be served (deploy)..." -ForegroundColor Cyan
  $ready = $false
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ($BaseUrl + $assetUrl) -Method Head -TimeoutSec 15
      if ($r.StatusCode -eq 200) {
        Write-Host ("Asset live: HTTP 200  ({0} bytes)" -f $r.Headers['Content-Length']) -ForegroundColor Green
        $ready = $true; break
      }
    } catch { Start-Sleep -Seconds 8 }
  }
  if (-not $ready) {
    Write-Host ("Timed out waiting for {0} -- it may still be deploying. Re-run with -NoWait once live." -f $assetUrl) -ForegroundColor Yellow
  }
}
# --- 5. Set the governor_photo setting via the CSRF-safe handshake ---------
$token = $env:TSMSVTE_TOKEN
if (-not $token) {
  Write-Host "TSMSVTE_TOKEN not set -- skipping the settings update. Asset is staged; set governor_photo=$assetUrl from Admin -> Site settings, or export TSMSVTE_TOKEN and re-run." -ForegroundColor Yellow
} else {
  $jar = Join-Path $env:TEMP ('tsmsvte-csrf-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $csrfRaw = (& curl.exe -s -S -c $jar "$BaseUrl/api/auth/csrf") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Could not reach $BaseUrl/api/auth/csrf" }
  $csrf = (Read-Json $csrfRaw).csrfToken
  if (-not $csrf) { throw "No CSRF token in response: $csrfRaw" }

  $payloadFile = Join-Path $env:TEMP ('tsmsvte-gov-' + [Guid]::NewGuid().ToString('N') + '.json')
  $payload = (@{ governor_photo = $assetUrl } | ConvertTo-Json -Compress)
  [IO.File]::WriteAllText($payloadFile, $payload, (New-Object Text.UTF8Encoding($false)))
  $setRaw = (& curl.exe -s -S -X PUT -b $jar `
    -H "Authorization: Bearer $token" -H "x-csrf-token: $csrf" `
    -H 'Content-Type: application/json' --data-binary "@$payloadFile" `
    -o - -w '|%{http_code}' "$BaseUrl/api/settings") -join "`n"
  $parts = $setRaw -split '\|(?=\d{3}$)', 2
  $code = if ($parts.Count -gt 1) { $parts[1] } else { '?' }
  $body = Read-Json $parts[0]
  if ($code -eq '200') {
    Write-Host ("governor_photo set -> {0}  (updated: {1})" -f $assetUrl, ($body.updated -join ', ')) -ForegroundColor Green
  } else {
    Write-Host ("Settings PUT failed (HTTP {0}): {1}" -f $code, $parts[0]) -ForegroundColor Red
  }
  Remove-Item $jar, $payloadFile -ErrorAction SilentlyContinue
}

# --- 6. Verify the live public setting actually resolves -------------------
Write-Host "Verifying public settings..." -ForegroundColor Cyan
try {
  $pub = (Invoke-RestMethod -UseBasicParsing -Uri "$BaseUrl/api/settings/public").settings
  $v = $pub.governor_photo
  $abs = if ($v -match '^https?://') { $v } else { $BaseUrl + $(if ($v -like '/*') { $v } else { "/$v" }) }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $abs -Method Head -TimeoutSec 15
    if ($r.StatusCode -eq 200) {
      Write-Host ("  ok   governor_photo = {0}  (HTTP {1})" -f $v, $r.StatusCode) -ForegroundColor Green
    } else {
      Write-Host ("  BAD  governor_photo = {0}  (HTTP {1})" -f $v, $r.StatusCode) -ForegroundColor Red
    }
  } catch {
    $c = try { $_.Exception.Response.StatusCode.value__ } catch { 'network error' }
    Write-Host ("  BAD  governor_photo = {0}  ({1})" -f $v, $c) -ForegroundColor Red
  }
} catch {
  Write-Host ("Verification failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
}

Write-Host "Done." -ForegroundColor Magenta
