param(
  [Parameter(Mandatory=$true)][ValidateSet('close-window','keep-open','quit-anyway','file-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TUSQuitWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  private static int target;
  private static List<IntPtr> windows;
  private static bool Collect(IntPtr hWnd, IntPtr extra) {
    uint owner;
    GetWindowThreadProcessId(hWnd, out owner);
    if (owner == target && IsWindowVisible(hWnd)) windows.Add(hWnd);
    return true;
  }
  public static IntPtr MainWindow(int processId) {
    target = processId; windows = new List<IntPtr>();
    EnumWindows(Collect, IntPtr.Zero);
    return windows.Count > 0 ? windows[0] : IntPtr.Zero;
  }
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueCondition = [System.Windows.Automation.Condition]::TrueCondition
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
)
switch ($Action) {
  'close-window' {
    $window = [TUSQuitWindow]::MainWindow($ProcessId)
    if ($window -eq [IntPtr]::Zero) { throw 'The packaged TUS window was not found.' }
    if (-not [TUSQuitWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
      throw 'Could not send the native window-close message.'
    }
    Write-Output 'Sent native WM_CLOSE to the packaged TUS window.'
    break
  }
  'keep-open'
  'quit-anyway' {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $dialog = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $topWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueCondition)
      foreach ($candidate in $topWindows) {
        try {
          if ($candidate.Current.ProcessId -ne $ProcessId) { continue }
          $elements = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueCondition)
          $names = @($candidate.Current.Name)
          foreach ($element in $elements) { try { $names += $element.Current.Name } catch {} }
          if ($names -contains 'The current Codex activity is unknown.' -and
              $names -contains 'Keep the game open' -and $names -contains 'Quit anyway') {
            $dialog = $candidate
            break
          }
        } catch {}
      }
      if ($dialog) { break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $dialog) { throw 'The expected unknown-Codex native quit confirmation was not found.' }
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
    $button = $null
    foreach ($candidate in $buttons) { if ($candidate.Current.Name -eq $buttonName) { $button = $candidate; break } }
    if (-not $button) { throw "Expected native quit button '$buttonName' was not found." }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Clicked native '$buttonName' button."
    break
  }
  'file-exit' {
    $fileName = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'File'
    )
    $menuType = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::MenuItem
    )
    $fileCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.Condition[]]@($processCondition, $fileName, $menuType)
    )
    $file = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)
    if (-not $file) { throw 'The packaged TUS File menu was not found.' }
    try { $file.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    catch { $file.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    $exitName = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and -not $exitName) {
      $items = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
          $processCondition,
          [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::MenuItem
          )
        ))
      )
      foreach ($item in $items) {
        if ($item.Current.Name -match '^(Exit|Quit)$') { $exitName = $item.Current.Name; $exitItem = $item; break }
      }
      if (-not $exitName) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $exitName) { throw 'The packaged TUS File menu did not expose an Exit or Quit command.' }
    $exitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Invoked File -> $exitName."
    break
  }
}
