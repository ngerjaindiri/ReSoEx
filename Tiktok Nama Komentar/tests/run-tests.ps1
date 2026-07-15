$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$failed = 0; $passed = 0

function Assert-Eq($a, $b, $name) {
  if ("$a" -ne "$b") { Write-Host "  X $name" -ForegroundColor Red; Write-Host "    expected:$b actual:$a" -ForegroundColor DarkRed; $script:failed++ }
  else { Write-Host "  OK $name" -ForegroundColor Green; $script:passed++ }
}
function Assert-True($cond, $name) {
  if (-not $cond) { Write-Host "  X $name" -ForegroundColor Red; $script:failed++ }
  else { Write-Host "  OK $name" -ForegroundColor Green; $script:passed++ }
}

function Normalize-Name([string]$raw) {
  if ([string]::IsNullOrEmpty($raw)) { return "" }
  $name = ($raw -replace "\s+", " ").Trim()
  if ($name.StartsWith("@") -and $name -notmatch " ") { $name = $name.Substring(1) }
  if ($name -match "^(like|reply|comment|tiktok)$") { return "" }
  return $name
}
function Merge-Names($a, $b) {
  $map = [ordered]@{}
  foreach ($n in @($a) + @($b)) {
    $k = Normalize-Name $n
    if ($k -and -not $map.Contains($k.ToLowerInvariant())) { $map[$k.ToLowerInvariant()] = $k }
  }
  return @($map.Values)
}
function Extract-Aweme([string]$url) {
  if ($url -match "/(?:video|photo)/(\d+)") { return $Matches[1] }
  return $null
}

Write-Host "`n== TikTok Nama Komentar audit =="
Assert-Eq (Normalize-Name "  Rina  ") "Rina" "normalize"
Assert-Eq (Normalize-Name "@handle") "handle" "strip @"
$m = Merge-Names @("Rina") @("rina","Budi"); Assert-Eq ($m -join ",") "Rina,Budi" "merge"
Assert-Eq (Extract-Aweme "https://www.tiktok.com/@u/video/7123") "7123" "aweme"
Assert-True (-not (Extract-Aweme "https://www.tiktok.com/foryou")) "no aweme foryou"

$payloadComments = @(
  @{ user = @{ nickname = "Budi Santoso"; unique_id = "user_budi_xyz" } },
  @{ user = @{ nickname = "Siti Aminah"; unique_id = "user_siti_xyz" } },
  @{ user = @{ nickname = "Budi Santoso"; unique_id = "user_budi_xyz" } }
)
$nicks = Merge-Names @() ($payloadComments | ForEach-Object { $_.user.nickname })
$handles = $payloadComments | ForEach-Object { $_.user.unique_id } | Select-Object -Unique
Assert-True ($nicks -contains "Budi Santoso") "nick Budi"
Assert-True ($nicks -contains "Siti Aminah") "nick Siti"
Assert-Eq (($nicks | Where-Object { $_ -eq "Budi Santoso" }).Count) 1 "unique"
Assert-True (-not ($nicks -contains "user_budi_xyz")) "not unique_id field"

$man = Get-Content (Join-Path $Root "manifest.json") -Raw | ConvertFrom-Json
Assert-Eq $man.manifest_version 3 "mv3"
Assert-Eq $man.version "1.1.2" "version"
Assert-True ($man.permissions -contains "webRequest") "webRequest"
Assert-True ($null -eq $man.web_accessible_resources -or $man.web_accessible_resources.Count -eq 0) "no WAR"

$files = @("background.js","content.js","inject.js","popup.html","popup.js","popup.css","content.css","shared.js","icons/icon16.png","icons/icon48.png","icons/icon128.png")
foreach ($f in $files) { Assert-True (Test-Path (Join-Path $Root $f)) "exists $f" }

Assert-True (-not (Test-Path "C:\Extention\FB Komentar Export")) "friend FB deleted"
Assert-True (-not (Test-Path "C:\Extention\Tiktok Komentar Export")) "friend TT deleted"

$bg = Get-Content (Join-Path $Root "background.js") -Raw
$ct = Get-Content (Join-Path $Root "content.js") -Raw
$inj = Get-Content (Join-Path $Root "inject.js") -Raw
$sh = Get-Content (Join-Path $Root "shared.js") -Raw

Assert-True ($bg -match "isStaleRun") "stale bg"
Assert-True ($bg -match "comment/list") "capture list"
Assert-True ($bg -notmatch "cookies\.getAll") "no cookies API"
Assert-True ($bg -notmatch "freeLimit|toolmagic|firebase|sentry") "clean bg"
Assert-True ($ct -match "stopFinalizeTimer") "stop finalize"
Assert-True ($ct -match "isCurrentRun") "run guard"
Assert-True ($inj -match "nickname") "nickname"
Assert-True ($inj -match "X-Bogus") "strip signature"
Assert-True ($inj -match "NEED_TEMPLATE") "template poll"
Assert-True ($inj -match "myRunId") "restart-safe run"
Assert-True ($ct -match 'postToInject\("STOP"\)') "SPA stops engine"
Assert-True ($bg -notmatch "templateAwemeId") "no dead param"
Assert-True ($bg -match "STOP_EXTRACT") "reset stops"
Assert-True ($inj -notmatch "toolmagic|freeLimit|sentry") "clean inject"
Assert-True ($sh -match "isStaleRun") "shared stale"
Assert-True ($sh -notmatch "buildCommentListUrl|parseCommentPage") "no dead shared exports"
Assert-True ($bg -match "status === `"running`"") "template no clobber running"

Write-Host "`nResults: $passed passed, $failed failed`n"
if ($failed -gt 0) { exit 1 } else { exit 0 }
