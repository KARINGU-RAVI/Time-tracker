# Makes the icons an installed app needs, from the same original mark as the logo. Run: powershell -File branding/make-app-icons.ps1
Add-Type -AssemblyName System.Drawing

# $rounded: the logo's rounded square on a transparent corner ("any" icons).
# Otherwise a full-bleed square, which phones crop into their own shape (maskable and Apple icons); $markScale keeps the mark inside the safe area.
function New-Icon([int]$size, [string]$path, [bool]$rounded, [double]$markScale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $indigo = [System.Drawing.ColorTranslator]::FromHtml('#3B4CCA')
  $brush = New-Object System.Drawing.SolidBrush $indigo

  if ($rounded) {
    $r = 112 * $size / 512.0
    $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shape.AddArc(0, 0, $r, $r, 180, 90)
    $shape.AddArc($size - $r, 0, $r, $r, 270, 90)
    $shape.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
    $shape.AddArc(0, $size - $r, $r, $r, 90, 90)
    $shape.CloseFigure()
    $g.FillPath($brush, $shape)
  } else {
    $g.FillRectangle($brush, 0, 0, $size, $size)
  }

  $s = $markScale * $size / 512.0
  $c = $size / 2.0
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (40 * $s)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $rad = 132 * $s
  $g.DrawArc($pen, ($c - $rad), ($c - $rad), (2 * $rad), (2 * $rad), 0, 270)
  $g.DrawLine($pen, $c, $c, ($c + 56 * $s), ($c - 56 * $s))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$out = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'frontend/public/icons'
New-Item -ItemType Directory -Force $out | Out-Null
New-Icon 192 (Join-Path $out 'icon-192.png') $true 1.0
New-Icon 512 (Join-Path $out 'icon-512.png') $true 1.0
New-Icon 512 (Join-Path $out 'icon-maskable-512.png') $false 0.72   # the mark stays inside the central 80% that every phone keeps
New-Icon 180 (Join-Path $out 'apple-touch-icon.png') $false 0.85
Get-ChildItem $out | Select-Object Name, Length
