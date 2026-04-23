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

$ep     = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $Port)
$server = [System.Net.Sockets.TcpListener]::new($ep)
$server.Start()
Write-Host "Serving http://localhost:$Port/ from $root"

while ($true) {
    $client = $server.AcceptTcpClient()
    $client.ReceiveTimeout = 3000   # 3 s read timeout
    $client.SendTimeout    = 10000  # 10 s write timeout
    $stream = $client.GetStream()

    try {
        # Read request line-by-line until blank line (end of headers)
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

        # Parse: "GET /path?q HTTP/1.x"
        $firstLine = ($reqText -split "`r`n")[0]
        $parts     = $firstLine -split ' '
        $urlPath   = if ($parts.Count -ge 2) { ($parts[1] -split '\?')[0] } else { '/' }
        if ($urlPath -eq '/') { $urlPath = '/index.html' }
        Write-Host "$($parts[0]) $urlPath"

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

        # Respond with HTTP/1.0 — always closes after response, no keep-alive needed
        $headerStr = "HTTP/1.0 $status`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`n`r`n"
        $hBytes    = [System.Text.Encoding]::ASCII.GetBytes($headerStr)

        $stream.Write($hBytes, 0, $hBytes.Length)
        $stream.Write($body,   0, $body.Length)
        $stream.Flush()
    } catch {
        Write-Host "ERR: $_"
    } finally {
        try { $stream.Close() } catch {}
        try { $client.Close() } catch {}
    }
}
