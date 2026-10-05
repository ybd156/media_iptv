Add-Type -AssemblyName System.Drawing

function New-Icon($size, $path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(13,21,38), [System.Drawing.Color]::FromArgb(35,80,180), 45)
    $g.FillRectangle($brush, $rect)
    $cx = $size / 2.0
    $r = $size * 0.26
    $pts = @(
        (New-Object System.Drawing.PointF([float]($cx - $r * 0.7), [float]($cx - $r))),
        (New-Object System.Drawing.PointF([float]($cx - $r * 0.7), [float]($cx + $r))),
        (New-Object System.Drawing.PointF([float]($cx + $r), [float]$cx))
    )
    $triBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(80,160,255))
    $g.FillPolygon($triBrush, $pts)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

function New-Banner($w, $h, $path) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAlias'
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(13,21,38), [System.Drawing.Color]::FromArgb(30,70,160), 0)
    $g.FillRectangle($brush, $rect)
    $cx = $w * 0.22
    $cy = $h / 2.0
    $r = $h * 0.28
    $pts = @(
        (New-Object System.Drawing.PointF([float]($cx - $r * 0.7), [float]($cy - $r))),
        (New-Object System.Drawing.PointF([float]($cx - $r * 0.7), [float]($cy + $r))),
        (New-Object System.Drawing.PointF([float]($cx + $r), [float]$cy))
    )
    $triBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(80,160,255))
    $g.FillPolygon($triBrush, $pts)
    $font = New-Object System.Drawing.Font("Arial", [float]($h * 0.30), [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.DrawString("MediaIPTV", $font, $textBrush, [float]($w * 0.36), [float]($h * 0.18))
    $font2 = New-Object System.Drawing.Font("Arial", [float]($h * 0.15), [System.Drawing.FontStyle]::Regular)
    $textBrush2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(160,175,200))
    $g.DrawString("Live TV", $font2, $textBrush2, [float]($w * 0.36), [float]($h * 0.60))
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

$base = "c:\Users\Z\Documents\trae_projects\MediaIptv\android\app\src\main\res"
New-Item -ItemType Directory -Force "$base\mipmap-mdpi", "$base\mipmap-hdpi", "$base\mipmap-xhdpi", "$base\mipmap-xxhdpi", "$base\mipmap-xxxhdpi" | Out-Null
New-Item -ItemType Directory -Force "$base\drawable-mdpi", "$base\drawable-hdpi", "$base\drawable-xhdpi", "$base\drawable-xxhdpi" | Out-Null
# 正方形启动图标（手机/盒子桌面）
New-Icon 48  "$base\mipmap-mdpi\ic_launcher.png"
New-Icon 72  "$base\mipmap-hdpi\ic_launcher.png"
New-Icon 96  "$base\mipmap-xhdpi\ic_launcher.png"
New-Icon 144 "$base\mipmap-xxhdpi\ic_launcher.png"
New-Icon 192 "$base\mipmap-xxxhdpi\ic_launcher.png"
# 长方形 TV 横幅（Leanback 桌面，按密度避免拉伸模糊）
New-Banner 320 180 "$base\drawable-mdpi\app_banner.png"
New-Banner 480 270 "$base\drawable-hdpi\app_banner.png"
New-Banner 640 360 "$base\drawable-xhdpi\app_banner.png"
New-Banner 960 540 "$base\drawable-xxhdpi\app_banner.png"
Remove-Item "$base\drawable\app_banner.png" -Force -ErrorAction SilentlyContinue
Remove-Item "$base\drawable\app_banner.xml" -Force -ErrorAction SilentlyContinue
Write-Output "icons generated"
