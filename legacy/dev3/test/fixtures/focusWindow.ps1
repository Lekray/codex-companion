param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TestWindowFocus {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int mode);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  private delegate bool WindowVisitor(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out Rect rect);
  public static IntPtr FindWindow(int[] processIds) {
    IntPtr result = IntPtr.Zero;
    long largest = 0;
    EnumWindows((h, data) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(processIds, (int)pid) < 0) return true;
      var name = new StringBuilder(128); GetClassName(h, name, 128);
      if (name.ToString() == "Chrome_WidgetWin_1") {
        Rect rect; GetWindowRect(h, out rect);
        long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
        if (area > largest) { largest = area; result = h; }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[TestWindowFocus]::SetProcessDPIAware() | Out-Null
$ids = [System.Collections.Generic.List[int]]::new()
$ids.Add($ProcessId)
$processes = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
do {
  $before = $ids.Count
  foreach ($entry in $processes) {
    if ($ids.Contains([int]$entry.ParentProcessId) -and !$ids.Contains([int]$entry.ProcessId)) { $ids.Add([int]$entry.ProcessId) }
  }
} while ($ids.Count -gt $before)
$window = [TestWindowFocus]::FindWindow($ids.ToArray())
if ($window -eq [IntPtr]::Zero) { throw 'Test process has no window.' }
[uint32]$foregroundPid = 0
[uint32]$targetPid = 0
[TestWindowFocus]::GetWindowThreadProcessId($window, [ref]$targetPid) | Out-Null
$thread = [TestWindowFocus]::GetWindowThreadProcessId([TestWindowFocus]::GetForegroundWindow(), [ref]$foregroundPid)
$current = [TestWindowFocus]::GetCurrentThreadId()
$attached = $false
try {
  if ($thread -ne $current) { $attached = [TestWindowFocus]::AttachThreadInput($current, $thread, $true) }
  [TestWindowFocus]::ShowWindowAsync($window, 9) | Out-Null
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    [TestWindowFocus]::SetForegroundWindow($window) | Out-Null
    Start-Sleep -Milliseconds 100
    [TestWindowFocus]::GetWindowThreadProcessId([TestWindowFocus]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
    if ($foregroundPid -eq $targetPid) { break }
  }
} finally {
  if ($attached) { [TestWindowFocus]::AttachThreadInput($current, $thread, $false) | Out-Null }
}
Start-Sleep -Milliseconds 150
[TestWindowFocus]::GetWindowThreadProcessId([TestWindowFocus]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
if ($foregroundPid -ne $targetPid) { throw 'Could not focus the specified test window.' }
Write-Output 'FOCUSED_TEST_WINDOW'
