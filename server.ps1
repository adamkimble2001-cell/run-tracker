param([int]$Port = 3400)

$root = $PSScriptRoot

$mimeMap = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css'
    '.js'   = 'application/javascript'
    '.json' = 'application/json'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
}

# ── Win32 / WinRT setup for OCR ───────────────────────────────────────────────
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinHelper {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ocrAvailable = $false
try {
    $null = [Windows.Media.Ocr.OcrEngine,                    Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder,         Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap,        Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter,             Windows.Storage.Streams, ContentType=WindowsRuntime]
    $ocrAvailable = $true
    Write-Host "OCR engine loaded." -ForegroundColor Green
} catch {
    Write-Host "WARNING: Windows OCR unavailable — kill detection via screenshot disabled." -ForegroundColor Yellow
}

function Invoke-WinRtAsync([object]$Op, [type]$T) {
    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
          Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
          Select-Object -First 1).MakeGenericMethod($T)
    $task = $m.Invoke($null, @(,$Op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

function Get-MegabonkKills {
    $result = @{ kills = $null; ocrText = ''; error = $null }
    try {
        # Find the process (try common name variations)
        $proc = Get-Process | Where-Object {
            $_.Name -like '*megabonk*' -or $_.MainWindowTitle -like '*Megabonk*'
        } | Select-Object -First 1
        if (!$proc -or $proc.MainWindowHandle -eq 0) {
            $result.error = 'Megabonk window not found'
            return $result
        }

        # Screenshot the window
        $rect = New-Object WinHelper+RECT
        [void][WinHelper]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
        $w = $rect.Right  - $rect.Left
        $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) { $result.error = 'Invalid window bounds'; return $result }

        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($w, $h))
        $gfx.Dispose()

        # Encode to PNG bytes
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $pngBytes = $ms.ToArray()
        $ms.Dispose()

        # Load into WinRT stream
        $ras = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
        $dw  = [Windows.Storage.Streams.DataWriter]::new($ras.GetOutputStreamAt(0))
        $dw.WriteBytes($pngBytes)
        $null = Invoke-WinRtAsync ($dw.StoreAsync()) ([uint32])
        $null = Invoke-WinRtAsync ($dw.FlushAsync()) ([bool])
        $ras.Seek(0)

        # Decode and run OCR
        $decoder   = Invoke-WinRtAsync ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras))   ([Windows.Graphics.Imaging.BitmapDecoder])
        $softBmp   = Invoke-WinRtAsync ($decoder.GetSoftwareBitmapAsync())                              ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine    = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        $ocrResult = Invoke-WinRtAsync ($engine.RecognizeAsync($softBmp))                               ([Windows.Media.Ocr.OcrResult])

        $text = $ocrResult.Text
        $result.ocrText = $text
        Write-Host "[megabonk/ocr] screen text: $text"

        # Parse kill count — try label:number and number:label patterns
        $kills = $null
        if      ($text -match '(?i)kills?\s*[:\-]?\s*(\d+)')       { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)(\d+)\s*kills?')                 { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)enemies?\s*[:\-]?\s*(\d+)')      { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)(\d+)\s*enemies?\s+killed')      { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)bonks?\s*[:\-]?\s*(\d+)')        { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)(\d+)\s*bonks?')                 { $kills = [int]$Matches[1] }
        elseif  ($text -match '(?i)(?:slain|defeated|killed)\s*[:\-]?\s*(\d+)') { $kills = [int]$Matches[1] }
        $result.kills = $kills
    } catch {
        $result.error = $_.Exception.Message
        Write-Host "[megabonk/ocr] error: $($_.Exception.Message)" -ForegroundColor Red
    }
    return $result
}

# ── Server ────────────────────────────────────────────────────────────────────
$ep     = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $Port)
$server = [System.Net.Sockets.TcpListener]::new($ep)

try {
    $server.Start()
} catch {
    Write-Host "ERROR: Cannot bind to port $Port — is it already in use?" -ForegroundColor Red
    Write-Host "Run: netstat -ano | findstr :$Port  to see what's using it." -ForegroundColor Yellow
    exit 1
}

Write-Host "Serving http://localhost:$Port/ from $root" -ForegroundColor Green
Write-Host "Open http://localhost:$Port in Chrome or Edge to test. Ctrl+C to stop." -ForegroundColor Cyan

while ($true) {
    try {
        $client = $server.AcceptTcpClient()
    } catch {
        Write-Host "Server stopped." -ForegroundColor Yellow
        break
    }

    $client.ReceiveTimeout = 3000
    $client.SendTimeout    = 10000
    $stream = $client.GetStream()

    try {
        $sb  = [System.Text.StringBuilder]::new()
        $buf = [byte[]]::new(1)
        while ($true) {
            try   { $n = $stream.Read($buf, 0, 1) }
            catch { $n = 0 }
            if ($n -eq 0) { break }
            [void]$sb.Append([char]$buf[0])
            if ($sb.Length -ge 4 -and $sb.ToString($sb.Length - 4, 4) -eq "`r`n`r`n") { break }
        }
        $reqText = $sb.ToString()

        $firstLine = ($reqText -split "`r`n")[0]
        $parts     = $firstLine -split ' '
        $urlPath   = if ($parts.Count -ge 2) { ($parts[1] -split '\?')[0] } else { '/' }
        if ($urlPath -eq '/') { $urlPath = '/index.html' }
        Write-Host "$($parts[0]) $urlPath"

        $extraHeaders = 'Access-Control-Allow-Origin: *' + "`r`n"

        if ($urlPath -eq '/api/megabonk') {
            $cloudDir = Join-Path $env:USERPROFILE 'AppData\LocalLow\Ved\Megabonk\Saves\CloudDir'
            $result   = @{}
            try {
                $steamDirs = Get-ChildItem $cloudDir -Directory -ErrorAction Stop |
                             Where-Object { $_.Name -match '^\d+$' }
                $statsFile = $null; $progFile = $null
                foreach ($dir in $steamDirs) {
                    $sf = Join-Path $dir.FullName 'stats.json'
                    if (Test-Path $sf -PathType Leaf) {
                        $statsFile = Get-Item $sf
                        $pf = Join-Path $dir.FullName 'progression.json'
                        if (Test-Path $pf -PathType Leaf) { $progFile = Get-Item $pf }
                        break
                    }
                }
                if ($statsFile) {
                    $result.statsMtime = [DateTimeOffset]::new($statsFile.LastWriteTimeUtc).ToUnixTimeMilliseconds()
                    $result.statsSize  = $statsFile.Length
                    if ($progFile) {
                        $result.progMtime = [DateTimeOffset]::new($progFile.LastWriteTimeUtc).ToUnixTimeMilliseconds()
                        $result.progSize  = $progFile.Length
                    }
                } else {
                    $result.error = 'stats.json not found in CloudDir — launch Megabonk at least once'
                }
            } catch {
                $result.error = $_.Exception.Message
            }
            $body   = [System.Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress -Depth 10))
            $status = '200 OK'
            $ct     = 'application/json'

        } elseif ($urlPath -eq '/api/megabonk/ocr') {
            if ($ocrAvailable) {
                $ocrData = Get-MegabonkKills
            } else {
                $ocrData = @{ kills = $null; ocrText = ''; error = 'OCR not available on this system' }
            }
            $body   = [System.Text.Encoding]::UTF8.GetBytes(($ocrData | ConvertTo-Json -Compress))
            $status = '200 OK'
            $ct     = 'application/json'

        } else {
            $relPath  = $urlPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
            $filePath = Join-Path $root $relPath

            if (Test-Path $filePath -PathType Leaf) {
                $ext      = [IO.Path]::GetExtension($filePath).ToLower()
                $mimeType = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { 'application/octet-stream' }
                $body     = [IO.File]::ReadAllBytes($filePath)
                $status   = '200 OK'
                $ct       = $mimeType
            } else {
                $body   = [System.Text.Encoding]::UTF8.GetBytes("Not Found: $urlPath")
                $status = '404 Not Found'
                $ct     = 'text/plain'
            }
        }

        $headerStr = "HTTP/1.0 $status`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`n${extraHeaders}Cache-Control: no-cache`r`n`r`n"
        $hBytes    = [System.Text.Encoding]::ASCII.GetBytes($headerStr)
        $stream.Write($hBytes, 0, $hBytes.Length)
        $stream.Write($body,   0, $body.Length)
        $stream.Flush()
    } catch {
        # Silently ignore individual request errors (e.g. client disconnected early)
    } finally {
        try { $stream.Close() } catch {}
        try { $client.Close() } catch {}
    }
}
