param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','file-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'
trap {
  $errorType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  Write-Output "TUS_UIA: automation-error-$errorType"
  exit 2
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TusWindowLookup {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
switch ($Action) {
  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $dialog = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $handle = [TusWindowLookup]::FindWindow($null, 'Codex activity may continue')
      if ($handle -ne [IntPtr]::Zero) {
        [uint32]$dialogProcessId = 0
        $null = [TusWindowLookup]::GetWindowThreadProcessId($handle, [ref]$dialogProcessId)
        if ($dialogProcessId -eq $ProcessId) {
          $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
          break
        }
      }
      Start-Sleep -Milliseconds 100
    }
    if (-not $dialog) { Write-Output 'TUS_UIA: quit-dialog-not-found'; throw 'The expected unknown-Codex native quit confirmation was not found.' }
    $unknownMessage = $dialog.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        'The current Codex activity is unknown.'
      )
    )
    if (-not $unknownMessage) { Write-Output 'TUS_UIA: quit-dialog-content-not-found'; throw 'The native quit dialog did not contain the expected unknown-activity message.' }
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
    $button = $null
    foreach ($candidate in $buttons) { if ($candidate.Current.Name -eq $buttonName) { $button = $candidate; break } }
    if (-not $button) { Write-Output 'TUS_UIA: quit-button-not-found'; throw "Expected native quit button '$buttonName' was not found." }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Clicked native '$buttonName' button."
    break
  }
  'file-exit' {
    $windowHandle = [Diagnostics.Process]::GetProcessById($ProcessId).MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
    $menuType = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::MenuItem
    )
    $fileCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'File'
      ),
      $menuType
    ))
    $file = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)
    if (-not $file) { Write-Output 'TUS_UIA: file-menu-not-found'; throw 'The packaged TUS File menu was not found.' }
    try { $file.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    catch { $file.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    $exitItem = $null
    $visibleNames = @()
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and -not $exitItem) {
      $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuType)
      foreach ($item in $items) {
        $visibleNames += $item.Current.Name
        if ($item.Current.Name -match '^(Exit|Quit)$') { $exitItem = $item; break }
      }
      if (-not $exitItem) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $exitItem) { Write-Output 'TUS_UIA: file-exit-not-found'; throw "File menu did not expose Exit or Quit; menu items: $($visibleNames -join ', ')" }
    $exitName = $exitItem.Current.Name
    $exitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Invoked File -> $exitName."
    break
  }
}
