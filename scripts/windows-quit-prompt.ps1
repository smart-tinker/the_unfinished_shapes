param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','file-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'
$script:uiPhase = 'startup'
trap {
  $errorType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  Write-Output "TUS_UIA: automation-error-$errorType-at-$script:uiPhase"
  exit 2
}
Write-Output 'TUS_UIA: script-start'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Write-Output 'TUS_UIA: automation-ready'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TusWindowLookup {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumLength);
  public static string GetWindowTitle(IntPtr window) {
    var text = new StringBuilder(256);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }
  public static IntPtr[] GetProcessWindows(uint targetProcessId) {
    var windows = new List<IntPtr>();
    EnumWindows((window, extraData) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId == targetProcessId && IsWindowVisible(window)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
Write-Output 'TUS_UIA: window-api-ready'
function FindExpectedQuitPrompt($Window, [string]$ButtonName) {
  $script:uiPhase = 'reading-prompt-title'
  if ($Window.Current.Name -ne 'Codex activity may continue') { return $null }
  $message = $null
  foreach ($expectedMessage in @(
    'Codex may still be working in this conversation.',
    'The current Codex activity is unknown.'
  )) {
    $script:uiPhase = 'reading-prompt-message'
    $message = $Window.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $expectedMessage
      )
    )
    if ($message) { break }
  }
  if (-not $message) { return $null }
  $script:uiPhase = 'reading-dialog-buttons'
  $buttons = $Window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  $buttonNames = @($buttons | ForEach-Object { $_.Current.Name })
  if ($buttons.Count -ne 2 -or
      $buttonNames -notcontains 'Keep the game open' -or
      $buttonNames -notcontains 'Quit anyway') { return $null }
  $button = $null
  foreach ($candidate in $buttons) {
    if ($candidate.Current.Name -eq $ButtonName) { $button = $candidate; break }
  }
  if (-not $button) { return $null }
  return [pscustomobject]@{ Message = $message; Button = $button }
}
switch ($Action) {
  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $mainWindowHandle = $process.MainWindowHandle
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $dialog = $null
    $dialogMessage = $null
    $quitButton = $null
    $ownedWindowCount = 0
    Write-Output 'TUS_UIA: locating-dialog'
    while ([DateTime]::UtcNow -lt $deadline -and -not $dialog) {
      $script:uiPhase = 'enumerating-process-windows'
      $handles = [TusWindowLookup]::GetProcessWindows([uint32]$ProcessId)
      $ownedWindowCount = 0
      foreach ($handle in $handles) {
        if ($handle -eq $mainWindowHandle) { continue }
        $ownedWindowCount++
        $script:uiPhase = 'opening-owned-window'
        $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        $script:uiPhase = 'reading-owned-window'
        $prompt = FindExpectedQuitPrompt $candidate $buttonName
        if ($prompt) {
          Write-Output 'TUS_UIA: target-dialog-found'
          $dialog = $candidate
          $dialogMessage = $prompt.Message
          $quitButton = $prompt.Button
          Write-Output 'TUS_UIA: dialog-accessible'
          break
        }
      }
      if (-not $dialog) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $dialog) {
      $script:uiPhase = 'checking-foreground-window'
      Write-Output 'TUS_UIA: checking-foreground-window'
      $foregroundHandle = [TusWindowLookup]::GetForegroundWindow()
      Write-Output 'TUS_UIA: foreground-handle-read'
      if ($foregroundHandle -ne [IntPtr]::Zero) {
        $script:uiPhase = 'reading-foreground-title'
        $foregroundTitle = [TusWindowLookup]::GetWindowTitle($foregroundHandle)
        Write-Output 'TUS_UIA: foreground-title-read'
        if ($foregroundTitle -eq 'Codex activity may continue') {
          Write-Output 'TUS_UIA: foreground-title-matched'
          $script:uiPhase = 'opening-foreground-window'
          $foreground = [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHandle)
          $prompt = FindExpectedQuitPrompt $foreground $buttonName
          if ($prompt) {
            Write-Output 'TUS_UIA: target-dialog-found'
            $dialog = $foreground
            $dialogMessage = $prompt.Message
            $quitButton = $prompt.Button
            Write-Output 'TUS_UIA: dialog-accessible'
          } else {
            Write-Output 'TUS_UIA: foreground-window-content-not-found'
          }
        } else {
          Write-Output 'TUS_UIA: foreground-window-content-not-found'
        }
      } else {
        Write-Output 'TUS_UIA: foreground-window-unavailable'
      }
    }
    if (-not $dialog) {
      Write-Output 'TUS_UIA: quit-dialog-not-found'
      if ($ownedWindowCount -eq 0) { Write-Output 'TUS_UIA: no-owned-dialog-window' }
      else { Write-Output 'TUS_UIA: owned-window-content-not-found' }
      exit 2
    }
    if (-not $dialogMessage -or -not $quitButton) { Write-Output 'TUS_UIA: quit-dialog-content-not-found'; exit 2 }
    $quitButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Clicked native '$buttonName' button."
    break
  }
  'file-exit' {
    Write-Output 'TUS_UIA: locating-main-window'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $windowHandle = $process.MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    Write-Output 'TUS_UIA: main-window-found'
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
    Write-Output 'TUS_UIA: file-menu-found'
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
