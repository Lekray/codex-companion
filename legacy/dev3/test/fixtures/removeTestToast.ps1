param([Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
if ($Title -notmatch '^source-project \u00b7 Companion test [0-9]+$') { throw 'Expected an isolated test notification title.' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$own = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('Microsoft.VisualStudioCode') | Where-Object { $_.Content.GetXml().Contains($Title) })
foreach ($toast in $own) { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($toast.Tag, $toast.Group, 'Microsoft.VisualStudioCode') }
Write-Output ('REMOVED_OWN_TEST_TOASTS=' + $own.Count)
