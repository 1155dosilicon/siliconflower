$src = "C:\Users\Eli\Desktop\ia\siliconflower-main"
$zip = "C:\Users\Eli\Desktop\siliconflower.zip"

if (Test-Path $zip) {
    Remove-Item $zip -Force
}

$tempDir = Join-Path $env:TEMP "siliconflower-clean-$(Get-Random)"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

$targetFolder = Join-Path $tempDir "siliconflower"
New-Item -ItemType Directory -Path $targetFolder | Out-Null

$exclude = @('node_modules', 'dist', '.openclaude', '.siliconflower', '.git')

Get-ChildItem -Path $src | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $targetFolder -Recurse -Force
}

Compress-Archive -Path $targetFolder -DestinationPath $zip -Force

Remove-Item $tempDir -Recurse -Force

Write-Host "Zip created successfully at: $zip"
$file = Get-Item $zip
$sizeKb = [math]::Round($file.Length / 1KB, 2)
$sizeMb = [math]::Round($file.Length / 1MB, 2)
Write-Host "Size: $sizeKb KB ($sizeMb MB)"
