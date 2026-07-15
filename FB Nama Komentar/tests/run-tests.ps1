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
  $name = ($raw -replace "[\u200b\u200c\u200d\ufeff]", "" -replace "\s+", " ").Trim()
  if ($name.Length -lt 2) { return "" }
  if ($name.StartsWith("@")) { return "" }
  if ($name -match "^(view|see|like|reply|share|comment)\b") { return "" }
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

Write-Host "`n== FB Nama Komentar audit =="
Assert-Eq (Normalize-Name "  Budi  Santoso ") "Budi Santoso" "normalize"
Assert-Eq (Normalize-Name "Like") "" "block UI"
$m = Merge-Names @("Ali","Budi") @("ali","Cici"); Assert-Eq ($m -join ",") "Ali,Budi,Cici" "merge"

$man = Get-Content (Join-Path $Root "manifest.json") -Raw | ConvertFrom-Json
Assert-Eq $man.manifest_version 3 "mv3"
Assert-Eq $man.version "1.4.1" "version"
Assert-True ($man.permissions -contains "scripting") "scripting"
Assert-True (-not ($man.permissions -contains "activeTab")) "no activeTab"
Assert-True ($null -eq $man.web_accessible_resources -or $man.web_accessible_resources.Count -eq 0) "no WAR"

$files = @("background.js","content.js","inject.js","popup.html","popup.js","popup.css","content.css","shared.js","icons/icon16.png","icons/icon48.png","icons/icon128.png")
foreach ($f in $files) { Assert-True (Test-Path (Join-Path $Root $f)) "exists $f" }

# no dead friend project leftovers
Assert-True (-not (Test-Path "C:\Extention\FB Komentar Export")) "friend FB project deleted"
Assert-True (-not (Test-Path "C:\Extention\Tiktok Komentar Export")) "friend TT project deleted"

$bg = Get-Content (Join-Path $Root "background.js") -Raw
$ct = Get-Content (Join-Path $Root "content.js") -Raw
$inj = Get-Content (Join-Path $Root "inject.js") -Raw
$sh = Get-Content (Join-Path $Root "shared.js") -Raw

Assert-True ($bg -match "isStaleRun") "stale guard bg"
Assert-True ($bg -match "newRunId") "runId bg"
Assert-True ($ct -match "stopFinalizeTimer") "stop finalize"
Assert-True ($ct -match "isCurrentRun") "run guard content"
Assert-True ($inj -match "findPostRoot") "post scope"
Assert-True ($inj -match "gqlBuffer|pushGqlBuffer") "always-on gql buffer"
Assert-True ($inj -match "gqlTemplates|captureGraphqlRequest") "esuit-like capture"
Assert-True ($inj -match "graphqlReplay|paginateGraphql") "esuit-like replay"
Assert-True ($inj -match "commentsAfterCursor|setCursorOnVariables") "cursor pagination"
Assert-True ($inj -match "scrapeDomNames") "dom scrape"
Assert-True ($inj -match "drainGqlBuffer") "drain buffer"
Assert-True ($inj -match "VERSION = 4") "engine v4"
Assert-True ($inj -match "currentRunId") "runId inject"
Assert-True ($inj -match "myRunId") "restart-safe run"
Assert-True ($bg -match "injectImmediately") "early inject"
Assert-True ($ct -match 'postToInject\("STOP"\)') "SPA stops engine"
Assert-True ($bg -match "STOP_EXTRACT") "reset stops"
Assert-True ($sh -match "reasonToMessage") "reason messages"
Assert-True ($inj -notmatch "esuit\.dev|webhookUrl|sentry\.io|stripe\.com") "clean-room inject"
Assert-True ($bg -notmatch "esuit\.dev|webhookUrl|sentry\.io") "clean-room bg"
Assert-True (-not (Test-Path (Join-Path $Root "tests\run-tests.mjs"))) "no dead mjs test"
Assert-True (-not (Test-Path (Join-Path $Root "tests\run-tests.py"))) "no dead py test"

# mock html
$html = Get-Content (Join-Path $Root "tests\mock-facebook.html") -Raw
Assert-True ($html -match "Comment by Budi") "mock has comments"

# Chrome headless engine harness (real DOM + GQL extract)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$harness = Join-Path $Root "tests\fb-engine-harness.html"
if ((Test-Path $chrome) -and (Test-Path $harness)) {
  $uri = ([System.Uri]$harness).AbsoluteUri
  $profile = Join-Path $Root "tests\chrome-profile"
  $dump = Join-Path $Root "tests\harness-out.html"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  & $chrome --headless=new --disable-gpu --no-first-run --user-data-dir="$profile" --virtual-time-budget=8000 --dump-dom $uri 2>$null | Out-File $dump -Encoding utf8
  $out = Get-Content $dump -Raw -ErrorAction SilentlyContinue
  Assert-True ($out -match "ALL_PASS") "chrome harness ALL_PASS"
  # Ensure result JSON does not list post owner as a commenter
  Assert-True ($out -match '"pass":\s*true') "harness pass true"
  Assert-True ($out -notmatch '"domNames"\s*:\s*\[[^\]]*"Pemilik Post"') "harness skips post owner in results"
} else {
  Write-Host "  skip chrome harness (no chrome)" -ForegroundColor Yellow
}

Write-Host "`nResults: $passed passed, $failed failed`n"
if ($failed -gt 0) { exit 1 } else { exit 0 }
