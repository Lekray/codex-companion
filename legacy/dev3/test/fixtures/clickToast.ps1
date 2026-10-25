param([Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ToastClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[ToastClick]::SetProcessDPIAware() | Out-Null
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
$openedCenter = $false
$start = [DateTime]::UtcNow
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $shellIds = @(Get-Process -Name ShellExperienceHost, ShellHost, explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  foreach ($window in $windows) {
    # Search the exact, unique test title across top-level providers. Shell
    # versions can host notifications in a process other than ShellHost.
    $target = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $target -and $shellIds -contains $window.Current.ProcessId) {
      $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($element in $elements) { if ($element.Current.Name.Contains($Title)) { $target = $element; break } }
    }
    if ($null -eq $target) { continue }
    $rect = $target.Current.BoundingRectangle
    if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $old = New-Object ToastClick+Point
    [ToastClick]::GetCursorPos([ref]$old) | Out-Null
    [ToastClick]::SetCursorPos([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2)) | Out-Null
    [ToastClick]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [ToastClick]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    [ToastClick]::SetCursorPos($old.X, $old.Y) | Out-Null
    Write-Output 'CLICKED_OWN_TEST_TOAST'
    exit 0
  }
  if (!$openedCenter -and ([DateTime]::UtcNow - $start).TotalSeconds -gt 2) {
    # If Windows suppressed the banner, inspect the notification center instead.
    $key = if ([Environment]::OSVersion.Version.Build -ge 22000) { 0x4e } else { 0x41 }
    [ToastClick]::keybd_event(0x5b, 0, 0, [UIntPtr]::Zero)
    [ToastClick]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [ToastClick]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
    [ToastClick]::keybd_event(0x5b, 0, 2, [UIntPtr]::Zero)
    $openedCenter = $true
  }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$ownToasts = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('Microsoft.VisualStudioCode') | Where-Object { $_.Content.GetXml().Contains($Title) })
Write-Output ('OWN_TEST_TOASTS_IN_HISTORY=' + $ownToasts.Count)
if ($openedCenter) {
  [ToastClick]::keybd_event(0x1b, 0, 0, [UIntPtr]::Zero)
  [ToastClick]::keybd_event(0x1b, 0, 2, [UIntPtr]::Zero)
}
throw 'The test toast was not visible through Windows UI Automation.'
