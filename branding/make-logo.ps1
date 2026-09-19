Add-Type -AssemblyName System.Drawing

function New-Logo([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 512.0
  $indigo = [System.Drawing.ColorTranslator]::FromHtml('#3B4CCA')

  # Rounded square background
  $r = 112 * $s
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
  $shape.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
  $shape.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
  $shape.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
  $shape.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $indigo), $shape)

  # Original mark: a progress ring with a gap at the top-right, and one hand pointing into the gap.
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (40 * $s)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $c = 256 * $s
  $rad = 132 * $s
  $g.DrawArc($pen, ($c - $rad), ($c - $rad), (2 * $rad), (2 * $rad), 0, 270)
  $g.DrawLine($pen, $c, $c, (256 + 56) * $s, (256 - 56) * $s)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$out = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Logo 512 (Join-Path $out 'office-hours-logo-512.png')
New-Logo 120 (Join-Path $out 'office-hours-logo-120.png')
Get-ChildItem $out -Filter *.png | Select-Object Name, Length
