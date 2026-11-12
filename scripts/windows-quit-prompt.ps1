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
  public static string LastPromptStatus = "not-checked";
  private const uint WM_GETTEXT = 0x000D;
  private const uint BM_CLICK = 0x00F5;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const uint SMTO_BLOCK = 0x0001;
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr extraData);
  private sealed class PromptControl {
    public IntPtr Handle;
    public string ClassName;
    public string Text;
    public PromptControl(IntPtr handle, string className, string text) {
      Handle = handle; ClassName = className; Text = text;
    }
  }
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumLength);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumLength);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeoutText(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeoutCommand(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static string GetWindowTitle(IntPtr window) {
    var text = new StringBuilder(256);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }
  private static string NormalizePromptText(string text) {
    if (String.IsNullOrWhiteSpace(text)) return "";
    return String.Join(" ", text.Split((char[])null, StringSplitOptions.RemoveEmptyEntries));
  }
  public static IntPtr FindExpectedQuitButton(IntPtr dialog, string[] expectedMessages, string requestedButton) {
    LastPromptStatus = "invalid-window";
    if (dialog == IntPtr.Zero) return IntPtr.Zero;
    if (GetWindowTitle(dialog) != "Codex activity may continue") {
      LastPromptStatus = "title-mismatch";
      return IntPtr.Zero;
    }
    if (expectedMessages == null) return IntPtr.Zero;
    var controls = new List<PromptControl>();
    EnumChildWindows(dialog, (child, extraData) => {
      var className = new StringBuilder(64);
      if (GetClassName(child, className, className.Capacity) == 0) return true;
      var name = className.ToString();
      var text = new StringBuilder(512);
      IntPtr ignored;
      if (SendMessageTimeoutText(child, WM_GETTEXT, new IntPtr(text.Capacity), text, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out ignored) == IntPtr.Zero) return true;
      controls.Add(new PromptControl(child, name, text.ToString()));
      return true;
    }, IntPtr.Zero);
    var buttons = new List<PromptControl>();
    bool hasExpectedMessage = false, hasKeepOpen = false, hasQuitAnyway = false;
    IntPtr requested = IntPtr.Zero;
    foreach (var control in controls) {
      if (control.ClassName != "Button") {
        var normalizedText = NormalizePromptText(control.Text);
        foreach (var message in expectedMessages) {
          if (normalizedText.IndexOf(message, StringComparison.Ordinal) >= 0) hasExpectedMessage = true;
        }
      } else if (control.ClassName == "Button") {
        buttons.Add(control);
        if (control.Text == "Keep the game open") hasKeepOpen = true;
        if (control.Text == "Quit anyway") hasQuitAnyway = true;
        if (control.Text == requestedButton) requested = control.Handle;
      }
    }
    if (buttons.Count != 2) {
      LastPromptStatus = "button-count-mismatch";
      return IntPtr.Zero;
    }
    if (!hasKeepOpen || !hasQuitAnyway) {
      LastPromptStatus = "expected-buttons-missing";
      return IntPtr.Zero;
    }
    if (requested == IntPtr.Zero) {
      LastPromptStatus = "requested-button-missing";
      return IntPtr.Zero;
    }
    if (!hasExpectedMessage) {
      LastPromptStatus = "title-buttons-text-unavailable";
      return requested;
    }
    LastPromptStatus = "matched";
    return requested;
  }
  public static bool ClickNativePromptButton(IntPtr button) {
    if (button == IntPtr.Zero) return false;
    IntPtr ignored;
    return SendMessageTimeoutCommand(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out ignored) != IntPtr.Zero;
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
switch ($Action) {
  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $expectedMessages = [string[]]@(
      'Codex may still be working in this conversation.',
      'The current Codex activity is unknown.',
      'Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped.',
      'Codex state could not be confirmed. Keep the game open and reconnect to check the conversation, or quit anyway.'
    )
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $mainWindowHandle = $process.MainWindowHandle
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $ownedWindowCount = 0
    $promptStatus = 'not-checked'
    Write-Output 'TUS_UIA: locating-dialog'
    while ([DateTime]::UtcNow -lt $deadline) {
      $script:uiPhase = 'enumerating-process-windows'
      $handles = [TusWindowLookup]::GetProcessWindows([uint32]$ProcessId)
      $ownedWindowCount = 0
      foreach ($handle in $handles) {
        if ($handle -eq $mainWindowHandle) { continue }
        $ownedWindowCount++
        $script:uiPhase = 'reading-owned-window'
        if ([TusWindowLookup]::GetWindowTitle($handle) -ne 'Codex activity may continue') { continue }
        $quitButton = [TusWindowLookup]::FindExpectedQuitButton($handle, $expectedMessages, $buttonName)
        $promptStatus = [TusWindowLookup]::LastPromptStatus
        if ($quitButton -ne [IntPtr]::Zero) {
          if ($promptStatus -eq 'title-buttons-text-unavailable') { Write-Output 'TUS_UIA: prompt-title-buttons-text-unavailable' }
          Write-Output 'TUS_UIA: target-dialog-found'
          Write-Output 'TUS_UIA: dialog-accessible'
          $script:uiPhase = 'clicking-native-button'
          if (-not [TusWindowLookup]::ClickNativePromptButton($quitButton)) { Write-Output 'TUS_UIA: quit-button-click-failed'; exit 2 }
          Write-Output "Clicked native '$buttonName' button."
          exit 0
        }
      }
      Start-Sleep -Milliseconds 100
    }
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
        $script:uiPhase = 'reading-foreground-controls'
        $quitButton = [TusWindowLookup]::FindExpectedQuitButton($foregroundHandle, $expectedMessages, $buttonName)
        $promptStatus = [TusWindowLookup]::LastPromptStatus
        if ($quitButton -ne [IntPtr]::Zero) {
          if ($promptStatus -eq 'title-buttons-text-unavailable') { Write-Output 'TUS_UIA: prompt-title-buttons-text-unavailable' }
          Write-Output 'TUS_UIA: target-dialog-found'
          Write-Output 'TUS_UIA: dialog-accessible'
          $script:uiPhase = 'clicking-native-button'
          if (-not [TusWindowLookup]::ClickNativePromptButton($quitButton)) { Write-Output 'TUS_UIA: quit-button-click-failed'; exit 2 }
          Write-Output "Clicked native '$buttonName' button."
          exit 0
        }
        Write-Output 'TUS_UIA: foreground-window-content-not-found'
      } else {
        $promptStatus = 'title-mismatch'
        Write-Output 'TUS_UIA: foreground-window-content-not-found'
      }
    } else {
      $promptStatus = 'foreground-window-unavailable'
      Write-Output 'TUS_UIA: foreground-window-unavailable'
    }
    Write-Output 'TUS_UIA: quit-dialog-not-found'
    if ($ownedWindowCount -eq 0) { Write-Output 'TUS_UIA: no-owned-dialog-window' }
    else { Write-Output 'TUS_UIA: owned-window-content-not-found' }
    Write-Output "TUS_UIA: prompt-$promptStatus"
    exit 2
  }
  'file-exit' {
    $script:uiPhase = 'locating-main-window'
    Write-Output 'TUS_UIA: locating-main-window'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $windowHandle = $process.MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { $windowHandle = [TusWindowLookup]::GetForegroundWindow() }
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetWindowTitle($windowHandle) -ne 'The Unfinished Shapes') { Write-Output 'TUS_UIA: main-window-title-mismatch'; throw 'The packaged TUS main window was not found.' }
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
    $script:uiPhase = 'opening-file-menu'
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('%f')
    Write-Output 'TUS_UIA: file-menu-shortcut-sent'
    $script:uiPhase = 'locating-file-menu'
    $file = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)
    if (-not $file) { Write-Output 'TUS_UIA: file-menu-not-found'; throw 'The packaged TUS File menu was not found.' }
    Write-Output 'TUS_UIA: file-menu-found'
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
