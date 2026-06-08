<#
.SYNOPSIS
  Собирает установщик SmartStock Мессенджера: стейджит exe + Qt-DLL + плагины +
  libsodium + CRT (и опц. вшивает адрес сервера) → запускает NSIS → один Setup.exe.

.PARAMETER Config
  Конфигурация сборки (Release по умолчанию).
.PARAMETER ServerUrl
  Склейка: если задан — вшивается в server.txt рядом с exe, и сотрудник НЕ вводит
  адрес сервера вручную (поле уже заполнено). Напр. https://erp.компания.ru
.PARAMETER Version
  Версия для имени установщика и реестра.

.EXAMPLE
  ./build_installer.ps1                                  # обычный установщик
  ./build_installer.ps1 -ServerUrl https://erp.acme.ru   # со вшитым адресом
#>
param(
  [string]$Config = "Release",
  [string]$ServerUrl = "",
  [string]$Version = "1.0.0",
  [string]$QtBin = "C:\Qt\6.5.3\msvc2019_64\bin",
  [string]$VcpkgBin = "C:\vcpkg\installed\x64-windows\bin",
  [string]$MakeNsis = "C:\Program Files (x86)\NSIS\makensis.exe"
)
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot            # messenger-desktop
$rel  = Join-Path $proj "build\$Config"
$exe  = Join-Path $rel  "smartstock-messenger.exe"
if (!(Test-Path $exe)) { throw "Сначала собери клиент: cmake --build build --config $Config" }

# 1) Чистый stage
$stage = Join-Path $proj "build\installer-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item $exe $stage

# 2) Qt-DLL и плагины (windeployqt; CRT доложим сами — надёжнее)
& (Join-Path $QtBin "windeployqt.exe") --no-translations --no-compiler-runtime (Join-Path $stage "smartstock-messenger.exe") | Out-Null

# 3) libsodium (E2E)
Copy-Item (Join-Path $VcpkgBin "libsodium.dll") $stage -Force

# 4) MSVC-runtime (чтобы стартовало на чистой машине)
foreach ($d in @("vcruntime140.dll","vcruntime140_1.dll","msvcp140.dll","concrt140.dll")) {
  $src = Join-Path $env:WINDIR "System32\$d"
  if (Test-Path $src) { Copy-Item $src $stage -Force }
}

# 5) Склейка: вшить адрес сервера
if ($ServerUrl -ne "") {
  Set-Content -Path (Join-Path $stage "server.txt") -Value $ServerUrl -NoNewline -Encoding UTF8
  Write-Host "Вшит адрес сервера: $ServerUrl"
}

# 6) NSIS → Setup.exe
$out = Join-Path $proj "установщики"
New-Item -ItemType Directory -Path $out -Force | Out-Null
$suffix = if ($ServerUrl -ne "") { "-" + (($ServerUrl -replace '^https?://','') -replace '[^a-zA-Z0-9.]','_') } else { "" }
$outFile = Join-Path $out "SmartStock-Messenger-$Version$suffix-Setup.exe"

& $MakeNsis "/DVERSION=$Version" "/DSTAGEDIR=$stage" "/DOUTFILE=$outFile" (Join-Path $PSScriptRoot "messenger.nsi")
if ($LASTEXITCODE -ne 0) { throw "makensis вернул $LASTEXITCODE" }
Write-Host "`nГотово: $outFile"
