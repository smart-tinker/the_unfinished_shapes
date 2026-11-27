param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','assert-body-mismatch-rejected','assert-exact-body-recognized','dismiss-test-prompt','file-menu-open','file-menu-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [ValidateSet('STA','MTA')][string]$Apartment = 'MTA',
  [string]$MenuKey,
  [string]$OwnerWindowHandle
)
$ErrorActionPreference = 'Stop'
$script:uiPhase = 'startup'
$script:uiaPromptTimeoutPhase = 'none'
$script:uiaApartment = $Apartment
$script:windowApiWatch = [Diagnostics.Stopwatch]::StartNew()
trap {
  $errorType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  Write-Output "TUS_UIA: automation-error-$errorType-at-$script:uiPhase"
  exit 2
}
Write-Output 'TUS_UIA: script-start'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public static class TusWindowLookup {
  public static string LastPromptStatus = "not-checked";
  public static string LastWindowLookupStatus = "not-checked";
  public static List<string> LastPromptEvidence = new List<string>();
  public static string LastPromptEvidenceText = "";
  private const uint WM_NULL = 0x0000;
  private const int ERROR_TIMEOUT = 1460;
  private const uint WM_GETTEXT = 0x000D;
  private const uint BM_CLICK = 0x00F5;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const uint SMTO_BLOCK = 0x0001;
  private const uint GW_OWNER = 4;
  private const uint GA_ROOTOWNER = 3;
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr extraData);
  private sealed class PromptControl {
    public int Index;
    public IntPtr Handle;
    public string ClassName;
    public bool ClassRead;
    public string Text;
    public bool TextRead;
    public int TextLength;
    public bool TextCapHit;
    public PromptControl(int index, IntPtr handle, string className, bool classRead, string text, bool textRead, int textLength, bool textCapHit) {
      Index = index; Handle = handle; ClassName = className; ClassRead = classRead;
      Text = text; TextRead = textRead; TextLength = textLength; TextCapHit = textCapHit;
    }
  }
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
  [DllImport("user32.dll")]
  private static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumLength);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeoutText(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr SendMessageTimeoutCommand(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static string ProbeExpectedOwnerWindow(int expectedProcessId, string expectedOwnerHandle, uint timeoutMilliseconds) {
    IntPtr expectedOwner = ParseWindowHandle(expectedOwnerHandle);
    if (timeoutMilliseconds == 0 || expectedProcessId <= 0 || expectedOwner == IntPtr.Zero ||
        GetWindowProcessId(expectedOwner) != expectedProcessId) return "unknown";
    IntPtr ignored;
    IntPtr sent = SendMessageTimeoutCommand(expectedOwner, WM_NULL, IntPtr.Zero, IntPtr.Zero,
      SMTO_ABORTIFHUNG | SMTO_BLOCK, timeoutMilliseconds, out ignored);
    if (sent != IntPtr.Zero) return "responsive";
    return Marshal.GetLastWin32Error() == ERROR_TIMEOUT ? "timeout" : "unknown";
  }
  public static string GetWindowTitle(IntPtr window) {
    var text = new StringBuilder(256);
    IntPtr ignored;
    if (SendMessageTimeoutText(window, WM_GETTEXT, new IntPtr(text.Capacity), text, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out ignored) == IntPtr.Zero) return "";
    return text.ToString();
  }
  private static string NormalizePromptText(string text) {
    if (String.IsNullOrWhiteSpace(text)) return "";
    return String.Join(" ", text.Split((char[])null, StringSplitOptions.RemoveEmptyEntries));
  }
  private static string SafeClassToken(string value) {
    var token = new StringBuilder(24);
    foreach (char c in value) {
      if (c >= 'A' && c <= 'Z') token.Append((char)(c + ('a' - 'A')));
      else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) token.Append(c);
      if (token.Length == 24) break;
    }
    return token.Length == 0 ? "unknown" : token.ToString();
  }
  private static string ExpectedFieldToken(int index) {
    if (index == 0) return "known-message";
    if (index == 1) return "unknown-message";
    return "candidate";
  }
  private static bool MatchesExpectedPromptDetail(int index, string actual, string[] expectedDetails, string goalStatusPrefix) {
    if (index == 0) {
      if (String.Equals(NormalizePromptText(actual), NormalizePromptText(expectedDetails[0]), StringComparison.Ordinal)) return true;
      string suffix = ". " + expectedDetails[0];
      if (String.IsNullOrEmpty(actual) || !actual.StartsWith(goalStatusPrefix, StringComparison.Ordinal) ||
          !actual.EndsWith(suffix, StringComparison.Ordinal)) return false;
      int statusLength = actual.Length - goalStatusPrefix.Length - suffix.Length;
      if (statusLength <= 0) return false;
      string status = actual.Substring(goalStatusPrefix.Length, statusLength);
      return !status.Contains("\r") && !status.Contains("\n");
    }
    return String.Equals(NormalizePromptText(actual), NormalizePromptText(expectedDetails[index]), StringComparison.Ordinal);
  }
  public static int GetWindowProcessId(IntPtr window) {
    if (window == IntPtr.Zero) return 0;
    int processId;
    return GetWindowThreadProcessId(window, out processId) == 0 ? 0 : processId;
  }
  private static IntPtr ParseWindowHandle(string value) {
    UInt64 parsed;
    if (String.IsNullOrEmpty(value) || value.Length > 16 ||
        !UInt64.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed)) return IntPtr.Zero;
    return new IntPtr(unchecked((long)parsed));
  }
  private static bool IsOwnedByExpectedWindow(IntPtr window, IntPtr expectedOwner) {
    return window != IntPtr.Zero && expectedOwner != IntPtr.Zero &&
      (GetWindow(window, GW_OWNER) == expectedOwner ||
       GetAncestor(window, GA_ROOTOWNER) == expectedOwner);
  }
  private static bool IsExpectedPromptWindow(IntPtr dialog, int expectedProcessId, IntPtr expectedOwner) {
    return dialog != IntPtr.Zero && expectedProcessId > 0 && expectedOwner != IntPtr.Zero &&
      GetWindowProcessId(expectedOwner) == expectedProcessId &&
      GetWindowProcessId(dialog) == expectedProcessId &&
      IsOwnedByExpectedWindow(dialog, expectedOwner) &&
      IsWindowVisible(dialog) && IsWindowEnabled(dialog);
  }
  public static IntPtr FindExpectedPromptWindow(int expectedProcessId, string expectedOwnerHandle) {
    LastWindowLookupStatus = "owner-window-unavailable";
    if (expectedProcessId <= 0) return IntPtr.Zero;
    IntPtr expectedOwner = ParseWindowHandle(expectedOwnerHandle);
    if (expectedOwner == IntPtr.Zero || GetWindowProcessId(expectedOwner) != expectedProcessId) return IntPtr.Zero;
    var matches = new List<IntPtr>();
    int sameProcessWindows = 0, ownedWindows = 0, foreignPromptWindows = 0;
    EnumWindows((window, extraData) => {
      if (window == expectedOwner || !IsWindowVisible(window) || !IsWindowEnabled(window)) return true;
      int processId = GetWindowProcessId(window);
      bool ownedByExpectedWindow = IsOwnedByExpectedWindow(window, expectedOwner);
      if (processId != expectedProcessId) {
        if (ownedByExpectedWindow && GetWindowTitle(window) == "Codex activity may continue") foreignPromptWindows++;
        return true;
      }
      sameProcessWindows++;
      if (!ownedByExpectedWindow) return true;
      ownedWindows++;
      if (GetWindowTitle(window) == "Codex activity may continue") matches.Add(window);
      return true;
    }, IntPtr.Zero);
    if (matches.Count == 1) {
      LastWindowLookupStatus = "window-matched";
      return matches[0];
    }
    LastWindowLookupStatus = matches.Count > 1 ? "window-ambiguous" :
      foreignPromptWindows > 0 ? "window-process-mismatch" :
      ownedWindows > 0 ? "window-title-mismatch" :
      sameProcessWindows > 0 ? "window-owner-mismatch" : "window-not-found";
    return IntPtr.Zero;
  }
  public static bool ActivateExpectedPromptWindow(IntPtr dialog, int expectedProcessId, string expectedOwnerHandle) {
    IntPtr expectedOwner = ParseWindowHandle(expectedOwnerHandle);
    if (!IsExpectedPromptWindow(dialog, expectedProcessId, expectedOwner) ||
        GetWindowTitle(dialog) != "Codex activity may continue") return false;
    if (GetForegroundWindow() != dialog) SetForegroundWindow(dialog);
    return GetForegroundWindow() == dialog && IsExpectedPromptWindow(dialog, expectedProcessId, expectedOwner) &&
      GetWindowTitle(dialog) == "Codex activity may continue";
  }
  public static IntPtr FindExpectedQuitButton(IntPtr dialog, int expectedProcessId, string expectedOwnerHandle, string[] expectedMessages, string[] expectedDetails, string goalStatusPrefix, string requestedButton, int uiaPromptIndex) {
    LastPromptStatus = "invalid-window";
    LastPromptEvidence.Clear();
    LastPromptEvidenceText = "";
    IntPtr expectedOwner = ParseWindowHandle(expectedOwnerHandle);
    if (!IsExpectedPromptWindow(dialog, expectedProcessId, expectedOwner)) return IntPtr.Zero;
    if (GetWindowTitle(dialog) != "Codex activity may continue") {
      LastPromptStatus = "title-mismatch";
      return IntPtr.Zero;
    }
    if (expectedMessages == null || expectedDetails == null || expectedMessages.Length != expectedDetails.Length) return IntPtr.Zero;
    var controls = new List<PromptControl>();
    int childIndex = 0;
    EnumChildWindows(dialog, (child, extraData) => {
      int index = childIndex++;
      var className = new StringBuilder(64);
      int classLength = GetClassName(child, className, className.Capacity);
      var name = className.ToString();
      var text = new StringBuilder(512);
      IntPtr returnedLength;
      bool textRead = SendMessageTimeoutText(child, WM_GETTEXT, new IntPtr(text.Capacity), text,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out returnedLength) != IntPtr.Zero;
      long length = returnedLength.ToInt64();
      int textLength = length <= 0 ? 0 : length > Int32.MaxValue ? Int32.MaxValue : (int)length;
      bool textCapHit = textLength >= text.Capacity - 1;
      controls.Add(new PromptControl(index, child, name, classLength > 0,
        textRead ? text.ToString() : "", textRead, textLength, textCapHit));
      return true;
    }, IntPtr.Zero);
    var buttons = new List<PromptControl>();
    bool hasUiPrompt = uiaPromptIndex >= 0 && uiaPromptIndex < expectedMessages.Length;
    int actualMessageIndex = -1, actualDetailIndex = -1, readableBodyTextCount = 0;
    bool conflictingNativeFields = false, unreadableBodyText = false, unknownBodyText = false;
    bool hasKeepOpen = false, hasQuitAnyway = false;
    if (hasUiPrompt) LastPromptEvidence.Add("uia-" + ExpectedFieldToken(uiaPromptIndex));
    IntPtr requested = IntPtr.Zero;
    foreach (var control in controls) {
      var classToken = SafeClassToken(control.ClassName);
      LastPromptEvidence.Add("child-" + control.Index + "-class-" + classToken +
        "-" + (control.ClassRead ? "classread" : "classunread") +
        "-" + (control.TextRead ? "textread" : "textunread") +
        "-len-" + control.TextLength + "-" + (control.TextCapHit ? "capped" : "uncapped"));
      if (!control.ClassRead) {
        LastPromptEvidence.Add("child-" + control.Index + "-candidate-class-unread");
        continue;
      }
      if (control.ClassName == "Button") {
        buttons.Add(control);
        if (control.Text == "Keep the game open") hasKeepOpen = true;
        if (control.Text == "Quit anyway") hasQuitAnyway = true;
        if (control.Text == requestedButton) requested = control.Handle;
        LastPromptEvidence.Add("child-" + control.Index + "-candidate-button");
        continue;
      }
      if (!control.TextRead || control.TextCapHit) {
        unreadableBodyText = true;
        LastPromptEvidence.Add("child-" + control.Index + "-candidate-unreadable");
        continue;
      }
      var normalizedText = NormalizePromptText(control.Text);
      if (normalizedText.Length == 0) continue;
      readableBodyTextCount++;
      int messageCandidate = -1, detailCandidate = -1;
      for (int i = 0; i < expectedMessages.Length; i++) {
        if (String.Equals(normalizedText, NormalizePromptText(expectedMessages[i]), StringComparison.Ordinal)) messageCandidate = i;
        if (MatchesExpectedPromptDetail(i, control.Text, expectedDetails, goalStatusPrefix)) detailCandidate = i;
      }
      if (messageCandidate >= 0) {
        if (actualMessageIndex >= 0 && actualMessageIndex != messageCandidate) conflictingNativeFields = true;
        actualMessageIndex = messageCandidate;
      }
      if (detailCandidate >= 0) {
        if (actualDetailIndex >= 0 && actualDetailIndex != detailCandidate) conflictingNativeFields = true;
        actualDetailIndex = detailCandidate;
      }
      if (messageCandidate >= 0 && detailCandidate >= 0 && messageCandidate != detailCandidate) conflictingNativeFields = true;
      if (messageCandidate < 0 && detailCandidate < 0) unknownBodyText = true;
      string candidate = messageCandidate >= 0 && detailCandidate >= 0 ? "complete-body" :
        messageCandidate >= 0 ? "message-" + (messageCandidate == 0 ? "known" : "unknown") :
        detailCandidate >= 0 ? "detail-" + (detailCandidate == 0 ? "known" : "unknown") : "body-unrecognized";
      LastPromptEvidence.Add("child-" + control.Index + "-candidate-" + candidate);
    }
    if (buttons.Count != 2) {
      LastPromptStatus = "button-count-mismatch";
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return IntPtr.Zero;
    }
    if (!hasKeepOpen || !hasQuitAnyway) {
      LastPromptStatus = "expected-buttons-missing";
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return IntPtr.Zero;
    }
    if (requested == IntPtr.Zero) {
      LastPromptStatus = "requested-button-missing";
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return IntPtr.Zero;
    }
    bool matchedNativeBody = actualMessageIndex >= 0 && actualMessageIndex == actualDetailIndex;
    bool completeBodyRead = readableBodyTextCount >= 2 && !unreadableBodyText;
    if (conflictingNativeFields || unknownBodyText ||
        (hasUiPrompt && ((actualMessageIndex >= 0 && actualMessageIndex != uiaPromptIndex) ||
          (actualDetailIndex >= 0 && actualDetailIndex != uiaPromptIndex))) ||
        (completeBodyRead && !matchedNativeBody)) {
      LastPromptStatus = "expected-body-mismatch";
      LastPromptEvidence.Add("body-mismatch");
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return IntPtr.Zero;
    }
    if (matchedNativeBody && !unreadableBodyText) {
      LastPromptStatus = "matched";
      LastPromptEvidence.Add("body-exact");
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return requested;
    }
    if (hasUiPrompt) {
      LastPromptStatus = "matched";
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return requested;
    }
    LastPromptStatus = "expected-body-unavailable";
    LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
    return IntPtr.Zero;
  }
  public static bool ClickNativePromptButton(IntPtr dialog, int expectedProcessId, string expectedOwnerHandle, IntPtr button, string requestedButton) {
    IntPtr expectedOwner = ParseWindowHandle(expectedOwnerHandle);
    int dialogProcessId = GetWindowProcessId(dialog);
    if (button == IntPtr.Zero || dialogProcessId <= 0 ||
        GetForegroundWindow() != dialog || !IsExpectedPromptWindow(dialog, expectedProcessId, expectedOwner) ||
        GetWindowProcessId(button) != dialogProcessId || !IsChild(dialog, button) ||
        GetWindowTitle(dialog) != "Codex activity may continue" || GetWindowTitle(button) != requestedButton) return false;
    IntPtr ignored;
    return SendMessageTimeoutCommand(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out ignored) != IntPtr.Zero;
  }

}
'@
$script:windowApiWatch.Stop()
Write-Output "TUS_UIA_TIMING: window-api-init-ms=$($script:windowApiWatch.ElapsedMilliseconds)"
Write-Output 'TUS_UIA: window-api-ready'
function Write-UiaPhaseMarker {
  param(
    [Parameter(Mandatory=$true)]
    [ValidateSet(
      'ui-child-starting', 'ui-child-started', 'ui-payload-preparing', 'ui-payload-ready',
      'ui-payload-writing', 'ui-payload-written', 'ui-child-waiting', 'ui-child-finished',
      'ui-child-killing', 'ui-child-kill-waiting', 'ui-child-exit-checking', 'ui-child-output-draining',
      'ui-child-finally-exit-checking', 'ui-child-finally-killing', 'ui-child-finally-waiting', 'ui-child-disposing'
    )]
    [string]$Phase
  )
  [Console]::Out.WriteLine('TUS_UIA: ' + $Phase)
  [Console]::Out.Flush()
}
function Find-ExpectedPromptWindowBounded {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $window = [TusWindowLookup]::FindExpectedPromptWindow($ProcessId, $OwnerWindowHandle)
    if ($window -ne [IntPtr]::Zero) { return $window }
    if ([TusWindowLookup]::LastWindowLookupStatus -eq 'owner-window-unavailable') { return [IntPtr]::Zero }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return [IntPtr]::Zero
}
function Write-PromptEvidence {
  $evidence = [TusWindowLookup]::LastPromptEvidenceText
  if ([string]::IsNullOrWhiteSpace($evidence)) { $evidence = 'none' }
  if ($evidence.Length -gt 512) { $evidence = $evidence.Substring(0, 512) }
  Write-Output "TUS_UIA: evidence-$evidence"
}
. (Join-Path $PSScriptRoot 'windows-uia-child-reader.ps1')
$script:uiaPromptResults = @{}
function Find-ValidatedPromptButton {
  param(
    [Parameter(Mandatory=$true)][IntPtr]$WindowHandle,
    [Parameter(Mandatory=$true)][string[]]$ExpectedMessages,
    [Parameter(Mandatory=$true)][string[]]$ExpectedDetails,
    [Parameter(Mandatory=$true)][string]$GoalStatusPrefix,
    [Parameter(Mandatory=$true)][string]$RequestedButton
  )
  $script:uiPhase = 'checking-exact-dialog-buttons'
  $button = [TusWindowLookup]::FindExpectedQuitButton(
    $WindowHandle, $ProcessId, $OwnerWindowHandle, $ExpectedMessages, $ExpectedDetails, $GoalStatusPrefix, $RequestedButton, -1)
  if ($button -ne [IntPtr]::Zero -or [TusWindowLookup]::LastPromptStatus -ne 'expected-body-unavailable') {
    return $button
  }

  $cacheKey = $WindowHandle.ToInt64().ToString()
  if (-not $script:uiaPromptResults.ContainsKey($cacheKey)) {
    $script:uiPhase = 'checking-accessible-prompt-body'
    $script:uiaPromptResults[$cacheKey] = Get-UiaPromptBodyResult $WindowHandle $ExpectedMessages $ExpectedDetails $GoalStatusPrefix -ExpectedProcessId $ProcessId -ExpectedOwnerHandle $OwnerWindowHandle -Apartment $script:uiaApartment
  }
  $uiaResult = [string]$script:uiaPromptResults[$cacheKey]
  if ($uiaResult -match '^timeout-(phase-[a-z0-9-]+|no-phase)$') {
    $script:uiaPromptTimeoutPhase = $Matches[1]
    [TusWindowLookup]::LastPromptStatus = 'expected-body-timeout'
    return [IntPtr]::Zero
  }
  if ($uiaResult -match '^matched-([01])$') {
    return [TusWindowLookup]::FindExpectedQuitButton(
      $WindowHandle, $ProcessId, $OwnerWindowHandle, $ExpectedMessages, $ExpectedDetails, $GoalStatusPrefix, $RequestedButton, [int]$Matches[1])
  }
  if ($uiaResult -eq 'mismatch') {
    [TusWindowLookup]::LastPromptStatus = 'expected-body-mismatch'
  } else {
    [TusWindowLookup]::LastPromptStatus = 'expected-body-unavailable'
  }
  return [IntPtr]::Zero
}
$expectedMessages = [string[]]@(
  'Codex may still be working in this conversation.',
  'The current Codex activity is unknown.'
)
$expectedDetails = [string[]]@(
  'Quitting TUS closes its Codex connection but does not confirm that a Goal or turn stopped. Keep the game open to pause or clear the Goal, or quit anyway.',
  'Codex state could not be confirmed. Keep the game open and reconnect to check the conversation, or quit anyway.'
)
$goalStatusPrefix = 'Native Goal status: '
switch ($Action) {
  { $_ -eq 'keep-open' -or $_ -eq 'quit-anyway' } {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $promptStatus = 'window-not-found'
    $reportedWindowMatch = $false
    $reportedForegroundMatch = $false
    Write-Output 'TUS_UIA: locating-process-dialog'
    while ([DateTime]::UtcNow -lt $deadline) {
      $script:uiPhase = 'checking-process-owned-prompt-window'
      $promptWindowHandle = [TusWindowLookup]::FindExpectedPromptWindow($ProcessId, $OwnerWindowHandle)
      if ($promptWindowHandle -eq [IntPtr]::Zero) {
        $promptStatus = [TusWindowLookup]::LastWindowLookupStatus
        if ($promptStatus -eq 'owner-window-unavailable') { break }
      } else {
        if (-not $reportedWindowMatch) {
          Write-Output 'TUS_UIA: prompt-window-matched'
          Write-Output 'TUS_UIA: prompt-dialog-process-match'
          $reportedWindowMatch = $true
        }
        $script:uiPhase = 'checking-exact-dialog-buttons'
        $quitButton = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix $buttonName
        $promptStatus = [TusWindowLookup]::LastPromptStatus
        if ($promptStatus -eq 'expected-body-mismatch') { break }
        if ($quitButton -ne [IntPtr]::Zero) {
          Write-PromptEvidence
          $script:uiPhase = 'foregrounding-exact-prompt'
          if (-not [TusWindowLookup]::ActivateExpectedPromptWindow($promptWindowHandle, $ProcessId, $OwnerWindowHandle)) {
            $promptStatus = 'foreground-activation-rejected'
            break
          }
          if (-not $reportedForegroundMatch) {
            Write-Output 'TUS_UIA: foreground-title-matched'
            $reportedForegroundMatch = $true
          }
          $script:uiPhase = 'checking-exact-dialog-buttons'
          $script:uiaPromptResults.Clear()
          $quitButton = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix $buttonName
          $promptStatus = [TusWindowLookup]::LastPromptStatus
          if ($promptStatus -eq 'expected-body-mismatch') { break }
          if ($quitButton -ne [IntPtr]::Zero) {
            Write-PromptEvidence
            Write-Output 'TUS_UIA: exact-foreground-prompt-matched'
            Write-Output 'TUS_UIA: dialog-accessible'
            $script:uiPhase = 'clicking-native-button'
            if (-not [TusWindowLookup]::ClickNativePromptButton($promptWindowHandle, $ProcessId, $OwnerWindowHandle, $quitButton, $buttonName)) { Write-Output 'TUS_UIA: quit-button-click-failed'; exit 2 }
            Write-Output "Clicked native '$buttonName' button."
            exit 0
          }
        }
      }
      Start-Sleep -Milliseconds 100
    }
    Write-PromptEvidence
    if ($script:uiaPromptTimeoutPhase -ne 'none') {
      Write-Output "TUS_UIA: prompt-reader-timeout-$script:uiaPromptTimeoutPhase"
    }
    Write-Output 'TUS_UIA: quit-dialog-not-found'
    Write-Output "TUS_UIA: prompt-$promptStatus"
    exit 2
  }
  'assert-exact-body-recognized' {
    $script:uiPhase = 'checking-exact-prompt-body'
    Write-Output 'TUS_UIA: locating-process-dialog'
    $promptWindowHandle = Find-ExpectedPromptWindowBounded
    if ($promptWindowHandle -eq [IntPtr]::Zero) {
      Write-Output "TUS_UIA: prompt-$([TusWindowLookup]::LastWindowLookupStatus)"
      exit 2
    }
    Write-Output 'TUS_UIA: prompt-window-matched'
    Write-Output 'TUS_UIA: prompt-dialog-process-match'
    $button = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
    Write-PromptEvidence
    if ($button -eq [IntPtr]::Zero) {
      if ($script:uiaPromptTimeoutPhase -ne 'none') {
        Write-Output "TUS_UIA: prompt-reader-timeout-$script:uiaPromptTimeoutPhase"
      }
      Write-Output "TUS_UIA: expected-body-$([TusWindowLookup]::LastPromptStatus)"
      exit 2
    }
    Write-Output 'TUS_UIA: expected-body-recognized'
  }
  'assert-body-mismatch-rejected' {
    $script:uiPhase = 'checking-modified-prompt-body'
    Write-Output 'TUS_UIA: locating-process-dialog'
    $promptWindowHandle = Find-ExpectedPromptWindowBounded
    if ($promptWindowHandle -eq [IntPtr]::Zero) {
      Write-Output "TUS_UIA: prompt-$([TusWindowLookup]::LastWindowLookupStatus)"
      exit 2
    }
    Write-Output 'TUS_UIA: prompt-window-matched'
    Write-Output 'TUS_UIA: prompt-dialog-process-match'
    $button = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
    Write-PromptEvidence
    if ($button -ne [IntPtr]::Zero) {
      Write-Output 'TUS_UIA: modified-body-button-returned'
      exit 2
    }
    $status = [TusWindowLookup]::LastPromptStatus
    if ($script:uiaPromptTimeoutPhase -ne 'none') {
      Write-Output "TUS_UIA: prompt-reader-timeout-$script:uiaPromptTimeoutPhase"
    }
    if ($status -ne 'expected-body-mismatch') {
      Write-Output "TUS_UIA: prompt-$status"
      Write-Output 'TUS_UIA: modified-body-unverified'
      exit 2
    }
    Write-Output 'TUS_UIA: modified-body-rejected'
  }
  'dismiss-test-prompt' {
    $script:uiPhase = 'dismissing-test-prompt'
    Write-Output 'TUS_UIA: locating-process-dialog'
    $promptWindowHandle = Find-ExpectedPromptWindowBounded
    if ($promptWindowHandle -eq [IntPtr]::Zero) {
      Write-Output 'TUS_UIA: test-prompt-not-found'
      Write-Output "TUS_UIA: prompt-$([TusWindowLookup]::LastWindowLookupStatus)"
      exit 2
    }
    Write-Output 'TUS_UIA: prompt-window-matched'
    Write-Output 'TUS_UIA: prompt-dialog-process-match'
    $button = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
    if ([TusWindowLookup]::LastPromptStatus -notin @('expected-body-mismatch', 'matched')) {
      if ($script:uiaPromptTimeoutPhase -ne 'none') {
        Write-Output "TUS_UIA: prompt-reader-timeout-$script:uiaPromptTimeoutPhase"
      }
      Write-Output 'TUS_UIA: test-prompt-not-found'
      Write-Output "TUS_UIA: prompt-$([TusWindowLookup]::LastPromptStatus)"
      exit 2
    }
    if (-not [TusWindowLookup]::ActivateExpectedPromptWindow($promptWindowHandle, $ProcessId, $OwnerWindowHandle)) {
      Write-Output 'TUS_UIA: test-prompt-not-found'
      Write-Output 'TUS_UIA: prompt-foreground-activation-rejected'
      exit 2
    }
    $script:uiaPromptResults.Clear()
    $button = Find-ValidatedPromptButton $promptWindowHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
    if ([TusWindowLookup]::LastPromptStatus -notin @('expected-body-mismatch', 'matched') -or
        [TusWindowLookup]::GetForegroundWindow() -ne $promptWindowHandle -or
        [TusWindowLookup]::GetWindowProcessId($promptWindowHandle) -ne $ProcessId -or
        [TusWindowLookup]::GetWindowTitle($promptWindowHandle) -ne 'Codex activity may continue') {
      Write-Output 'TUS_UIA: test-prompt-not-found'
      Write-Output 'TUS_UIA: prompt-foreground-activation-rejected'
      if ($script:uiaPromptTimeoutPhase -ne 'none') {
        Write-Output "TUS_UIA: prompt-reader-timeout-$script:uiaPromptTimeoutPhase"
        Write-Output "TUS_UIA: prompt-$([TusWindowLookup]::LastPromptStatus)"
      }
      exit 2
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Write-Output 'TUS_UIA: test-prompt-dismissed'
  }
  'file-menu-open' {
    $script:uiPhase = 'locating-main-window'
    Write-Output 'TUS_UIA: locating-main-window'
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    $windowHandle = $process.MainWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { $windowHandle = [TusWindowLookup]::GetForegroundWindow() }
    if ($windowHandle -eq [IntPtr]::Zero) { Write-Output 'TUS_UIA: app-window-not-found'; throw 'The packaged TUS main window was not found.' }
    if ([TusWindowLookup]::GetWindowProcessId($windowHandle) -ne $ProcessId) { Write-Output 'TUS_UIA: main-window-title-mismatch'; throw 'The packaged TUS main window was not found.' }
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
    if ([TusWindowLookup]::GetWindowProcessId($windowHandle) -ne $ProcessId) { Write-Output 'TUS_UIA: main-window-title-mismatch'; throw 'The packaged TUS main window was not found.' }
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
