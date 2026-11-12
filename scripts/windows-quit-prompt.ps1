param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','file-menu-open','file-menu-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [string]$MenuKey
)
$ErrorActionPreference = 'Stop'
$script:uiPhase = 'startup'
trap {
  $errorType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  Write-Output "TUS_UIA: automation-error-$errorType-at-$script:uiPhase"
  exit 2
}
Write-Output 'TUS_UIA: script-start'
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
$script:uiPhase = 'loading-ui-automation'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Test-ExactPromptText([IntPtr]$dialog, [string[]]$expectedMessages) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($dialog)
    if ($null -eq $root) { return $false }
    $elements = @($root) + @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
    foreach ($element in $elements) {
      $name = [regex]::Replace([string]$element.Current.Name, '\s+', ' ').Trim()
      foreach ($message in $expectedMessages) {
        $expected = [regex]::Replace([string]$message, '\s+', ' ').Trim()
        if ([string]::Equals($name, $expected, [StringComparison]::Ordinal)) { return $true }
      }
    }
  } catch {
    return $false
  }
  return $false
}
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
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $promptStatus = 'foreground-window-unavailable'
    $reportedTitleMatch = $false
    Write-Output 'TUS_UIA: locating-foreground-dialog'
    while ([DateTime]::UtcNow -lt $deadline) {
      $script:uiPhase = 'checking-foreground-window'
      $foregroundHandle = [TusWindowLookup]::GetForegroundWindow()
      if ($foregroundHandle -ne [IntPtr]::Zero) {
        $script:uiPhase = 'reading-foreground-title'
        if ([TusWindowLookup]::GetWindowTitle($foregroundHandle) -eq 'Codex activity may continue') {
          if (-not $reportedTitleMatch) {
            Write-Output 'TUS_UIA: foreground-title-matched'
            $reportedTitleMatch = $true
          }
          $script:uiPhase = 'checking-exact-dialog-text'
          if (Test-ExactPromptText $foregroundHandle $expectedMessages) {
            $script:uiPhase = 'checking-exact-dialog-buttons'
            $quitButton = [TusWindowLookup]::FindExpectedQuitButton($foregroundHandle, $expectedMessages, $buttonName)
            $promptStatus = [TusWindowLookup]::LastPromptStatus
            if ($quitButton -ne [IntPtr]::Zero) {
              Write-Output 'TUS_UIA: exact-foreground-prompt-matched'
              Write-Output 'TUS_UIA: dialog-accessible'
              $script:uiPhase = 'clicking-native-button'
              if (-not [TusWindowLookup]::ClickNativePromptButton($quitButton)) { Write-Output 'TUS_UIA: quit-button-click-failed'; exit 2 }
              Write-Output "Clicked native '$buttonName' button."
              exit 0
            }
          } else {
            $promptStatus = 'expected-message-mismatch'
          }
        } else {
          $promptStatus = 'foreground-title-mismatch'
        }
      }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'TUS_UIA: quit-dialog-not-found'
    Write-Output "TUS_UIA: prompt-$promptStatus"
    exit 2
  }
  'file-menu-open' {
    $script:uiPhase = 'locating-main-window'
    Write-Output 'TUS_UIA: locating-main-window'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $windowHandle = $process.MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { $windowHandle = [TusWindowLookup]::GetForegroundWindow() }
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetWindowTitle($windowHandle) -ne 'The Unfinished Shapes') { Write-Output 'TUS_UIA: main-window-title-mismatch'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetForegroundWindow() -ne $windowHandle) { Write-Output 'TUS_UIA: app-window-not-foreground'; throw 'The packaged TUS window is not foreground.' }
    Write-Output 'TUS_UIA: main-window-found'
    Add-Type -AssemblyName System.Windows.Forms
    $script:uiPhase = 'opening-file-menu'
    [System.Windows.Forms.SendKeys]::SendWait('%f')
    Write-Output 'TUS_UIA: file-menu-shortcut-sent'
    break
  }
  'file-menu-exit' {
    $script:uiPhase = 'locating-main-window'
    Write-Output 'TUS_UIA: locating-main-window'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $windowHandle = $process.MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { $windowHandle = [TusWindowLookup]::GetForegroundWindow() }
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetWindowTitle($windowHandle) -ne 'The Unfinished Shapes') { Write-Output 'TUS_UIA: main-window-title-mismatch'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetForegroundWindow() -ne $windowHandle) { Write-Output 'TUS_UIA: app-window-not-foreground'; throw 'The packaged TUS window is not foreground.' }
    if ($MenuKey -notmatch '^[eEqQ]$') { Write-Output 'TUS_UIA: invalid-file-menu-key'; throw 'The validated File Exit menu key is unavailable.' }
    Write-Output 'TUS_UIA: main-window-found'
    Add-Type -AssemblyName System.Windows.Forms
    $script:uiPhase = 'selecting-file-exit'
    [System.Windows.Forms.SendKeys]::SendWait($MenuKey)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Write-Output 'TUS_UIA: file-exit-menu-command-sent'
    break
  }
}
