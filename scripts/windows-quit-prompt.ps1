param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','assert-body-mismatch-rejected','assert-exact-body-recognized','dismiss-test-prompt','file-menu-open','file-menu-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [string]$MenuKey
)
$ErrorActionPreference = 'Stop'
$script:uiPhase = 'startup'
$script:uiaPromptTimeoutPhase = 'none'
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
  public static List<string> LastPromptEvidence = new List<string>();
  public static string LastPromptEvidenceText = "";
  private const uint WM_GETTEXT = 0x000D;
  private const uint BM_CLICK = 0x00F5;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const uint SMTO_BLOCK = 0x0001;
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
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr extraData);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumLength);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeoutText(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeoutCommand(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
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
  public static IntPtr FindExpectedQuitButton(IntPtr dialog, string[] expectedMessages, string requestedButton, int uiaPromptIndex) {
    LastPromptStatus = "invalid-window";
    LastPromptEvidence.Clear();
    LastPromptEvidenceText = "";
    if (dialog == IntPtr.Zero) return IntPtr.Zero;
    if (GetWindowTitle(dialog) != "Codex activity may continue") {
      LastPromptStatus = "title-mismatch";
      return IntPtr.Zero;
    }
    if (expectedMessages == null) return IntPtr.Zero;
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
    bool hasExpectedMessage = uiaPromptIndex >= 0 && uiaPromptIndex < expectedMessages.Length;
    bool hasReadableMessage = false, hasKeepOpen = false, hasQuitAnyway = false;
    if (hasExpectedMessage) LastPromptEvidence.Add("uia-" + ExpectedFieldToken(uiaPromptIndex));
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
      if (control.ClassName != "Button") {
        var normalizedText = NormalizePromptText(control.Text);
        if (normalizedText.Length > 0) {
          hasReadableMessage = true;
        }
        int candidate = -1;
        for (int i = 0; i < expectedMessages.Length; i++) {
          if (String.Equals(normalizedText, NormalizePromptText(expectedMessages[i]), StringComparison.Ordinal)) {
            hasExpectedMessage = true;
            candidate = i;
            break;
          }
        }
        LastPromptEvidence.Add("child-" + control.Index + "-candidate-" +
          (candidate < 0 ? (control.TextRead ? "none" : "unreadable") : ExpectedFieldToken(candidate)));
      } else {
        buttons.Add(control);
        if (control.Text == "Keep the game open") hasKeepOpen = true;
        if (control.Text == "Quit anyway") hasQuitAnyway = true;
        if (control.Text == requestedButton) requested = control.Handle;
        LastPromptEvidence.Add("child-" + control.Index + "-candidate-button");
      }
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
    if (!hasExpectedMessage) {
      LastPromptStatus = hasReadableMessage ? "expected-message-mismatch" : "expected-message-unavailable";
      LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
      return IntPtr.Zero;
    }
    LastPromptStatus = "matched";
    LastPromptEvidenceText = String.Join("-", LastPromptEvidence.ToArray());
    return requested;
  }
  public static bool ClickNativePromptButton(IntPtr button) {
    if (button == IntPtr.Zero) return false;
    IntPtr ignored;
    return SendMessageTimeoutCommand(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, out ignored) != IntPtr.Zero;
  }

}
'@
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
function Write-PromptEvidence {
  $evidence = [TusWindowLookup]::LastPromptEvidenceText
  if ([string]::IsNullOrWhiteSpace($evidence)) { $evidence = 'none' }
  if ($evidence.Length -gt 512) { $evidence = $evidence.Substring(0, 512) }
  Write-Output "TUS_UIA: evidence-$evidence"
}
function Get-UiaPromptBodyResult {
  param(
    [Parameter(Mandatory=$true)][IntPtr]$WindowHandle,
    [Parameter(Mandatory=$true)][string[]]$ExpectedMessages,
    [Parameter(Mandatory=$true)][string[]]$ExpectedDetails,
    [Parameter(Mandatory=$true)][string]$GoalStatusPrefix
  )
  $childScript = @'
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('TUS_UIA_CHILD: phase-child-start')
[Console]::Out.Flush()
try {
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-read-start')
  [Console]::Out.Flush()
  $payloadLine = [Console]::In.ReadLine()
  if ([string]::IsNullOrWhiteSpace($payloadLine)) { throw 'payload-unavailable' }
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-read-done')
  [Console]::Out.Flush()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-parse-start')
  [Console]::Out.Flush()
  $payloadJson = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payloadLine))
  $payload = ConvertFrom-Json -InputObject $payloadJson
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-parse-done')
  [Console]::Out.Flush()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-addtype-types-start')
  [Console]::Out.Flush()
  Add-Type -AssemblyName UIAutomationTypes
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-addtype-types-done')
  [Console]::Out.Flush()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-addtype-client-start')
  [Console]::Out.Flush()
  Add-Type -AssemblyName UIAutomationClient
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-addtype-client-done')
  [Console]::Out.Flush()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-fromhandle-start')
  [Console]::Out.Flush()
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$payload.handle))
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-fromhandle-done')
  [Console]::Out.Flush()
  if ($null -eq $root) { throw 'window-unavailable' }
  $expected = @($payload.expectedMessages)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  function Test-ExpectedPromptDetail {
    param([int]$Index, [string]$Detail)
    if ($Index -eq 0) {
      $knownDetail = [string]$payload.expectedDetails[0]
      if ([string]::Equals($Detail, $knownDetail, [StringComparison]::Ordinal)) { return $true }
      $prefix = [string]$payload.goalStatusPrefix
      $suffix = '. ' + $knownDetail
      if (-not $Detail.StartsWith($prefix, [StringComparison]::Ordinal) -or
          -not $Detail.EndsWith($suffix, [StringComparison]::Ordinal)) { return $false }
      $statusLength = $Detail.Length - $prefix.Length - $suffix.Length
      if ($statusLength -le 0) { return $false }
      $status = $Detail.Substring($prefix.Length, $statusLength)
      return -not $status.Contains([char]13) -and -not $status.Contains([char]10)
    }
    if ($Index -eq 1) {
      return [string]::Equals($Detail, [string]$payload.expectedDetails[1], [StringComparison]::Ordinal)
    }
    return $false
  }
  for ($index = 0; $index -lt $expected.Length; $index++) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      [string]$expected[$index])
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-findfirst-' + $index + '-start')
    [Console]::Out.Flush()
    $messageElement = $root.FindFirst(
      [System.Windows.Automation.TreeScope]::Children,
      $condition)
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-findfirst-' + $index + '-done')
    [Console]::Out.Flush()
    if ($null -eq $messageElement) { continue }
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-current-name-' + $index + '-start')
    [Console]::Out.Flush()
    $messageName = [string]$messageElement.GetCurrentPropertyValue(
      [System.Windows.Automation.AutomationElement]::NameProperty)
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-current-name-' + $index + '-done')
    [Console]::Out.Flush()
    if (-not [string]::Equals($messageName, [string]$expected[$index], [StringComparison]::Ordinal)) { continue }
    $detailElement = $messageElement
    for ($detailIndex = 0; $detailIndex -lt 8; $detailIndex++) {
      [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-next-sibling-' + $index + '-' + $detailIndex + '-start')
      [Console]::Out.Flush()
      $detailElement = $walker.GetNextSibling($detailElement)
      [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-next-sibling-' + $index + '-' + $detailIndex + '-done')
      [Console]::Out.Flush()
      if ($null -eq $detailElement) { break }
      [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-current-name-' + $index + '-' + $detailIndex + '-start')
      [Console]::Out.Flush()
      $detailName = [string]$detailElement.GetCurrentPropertyValue(
        [System.Windows.Automation.AutomationElement]::NameProperty)
      [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-current-name-' + $index + '-' + $detailIndex + '-done')
      [Console]::Out.Flush()
      if (Test-ExpectedPromptDetail $index $detailName) {
        [Console]::Out.WriteLine('TUS_UIA_CHILD: matched-' + $index)
        exit 0
      }
    }
  }
  [Console]::Out.WriteLine('TUS_UIA_CHILD: mismatch')
  exit 0
} catch {
  [Console]::Out.WriteLine('unavailable')
  exit 1
}
'@
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
  $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -STA -EncodedCommand ' + $encodedScript
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $childTokens = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
  $outputReadComplete = [System.Threading.ManualResetEvent]::new($false)
  $outputHandler = {
    param($sender, $eventArgs)
    if ($null -eq $eventArgs.Data) {
      try { [void]$outputReadComplete.Set() } catch {}
      return
    }
    $token = [regex]::Match([string]$eventArgs.Data, '^TUS_UIA_CHILD: (phase-[a-z0-9-]+|matched-[01]|mismatch|unavailable)$')
    if ($token.Success) { $childTokens.Enqueue($token.Groups[1].Value) }
  }.GetNewClosure()
  $process.add_OutputDataReceived([System.Diagnostics.DataReceivedEventHandler]$outputHandler)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    Write-UiaPhaseMarker 'ui-child-starting'
    if (-not $process.Start()) { return 'unavailable' }
    Write-UiaPhaseMarker 'ui-child-started'
    $process.BeginOutputReadLine()
    Write-UiaPhaseMarker 'ui-payload-preparing'
    $payload = ConvertTo-Json -InputObject @{
      handle = $WindowHandle.ToInt64(); expectedMessages = $ExpectedMessages
      expectedDetails = $ExpectedDetails; goalStatusPrefix = $GoalStatusPrefix
    } -Compress
    $payloadLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    Write-UiaPhaseMarker 'ui-payload-ready'
    Write-UiaPhaseMarker 'ui-payload-writing'
    $process.StandardInput.WriteLine($payloadLine)
    $process.StandardInput.Close()
    Write-UiaPhaseMarker 'ui-payload-written'
    $remaining = 3000 - [int]$watch.ElapsedMilliseconds
    Write-UiaPhaseMarker 'ui-child-waiting'
    if ($remaining -le 0 -or -not $process.WaitForExit($remaining)) {
      Write-UiaPhaseMarker 'ui-child-killing'
      try { $process.Kill() } catch {}
      Write-UiaPhaseMarker 'ui-child-kill-waiting'
      try { [void]$process.WaitForExit(1000) } catch {}
      Write-UiaPhaseMarker 'ui-child-exit-checking'
      $drainComplete = $false
      if ($process.HasExited) {
        Write-UiaPhaseMarker 'ui-child-output-draining'
        $remaining = 3000 - [int]$watch.ElapsedMilliseconds
        if ($remaining -gt 0) { $drainComplete = $outputReadComplete.WaitOne($remaining) }
      }
      if (-not $drainComplete) { return 'timeout-no-phase' }
      $phases = @($childTokens.ToArray() | Where-Object { $_ -match '^phase-' })
      if ($phases.Count -gt 0) { return 'timeout-' + $phases[$phases.Count - 1] }
      return 'timeout-no-phase'
    }
    Write-UiaPhaseMarker 'ui-child-output-draining'
    $remaining = 3000 - [int]$watch.ElapsedMilliseconds
    if ($remaining -le 0 -or -not $outputReadComplete.WaitOne($remaining)) { return 'unavailable' }
    Write-UiaPhaseMarker 'ui-child-finished'
    $results = @($childTokens.ToArray() | Where-Object { $_ -match '^(matched-[01]|mismatch|unavailable)$' })
    if ($process.ExitCode -eq 0 -and $results.Count -gt 0) {
      $result = $results[$results.Count - 1]
      if ($result -match '^matched-[01]$' -or $result -eq 'mismatch') { return $result }
    }
    return 'unavailable'
  } catch {
    return 'unavailable'
  } finally {
    try {
      try { Write-UiaPhaseMarker 'ui-child-finally-exit-checking' } catch {}
      if (-not $process.HasExited) {
        try { Write-UiaPhaseMarker 'ui-child-finally-killing' } catch {}
        $process.Kill()
        try { Write-UiaPhaseMarker 'ui-child-finally-waiting' } catch {}
        [void]$process.WaitForExit(1000)
      }
    } catch {}
    try { Write-UiaPhaseMarker 'ui-child-disposing' } catch {}
    try { $outputReadComplete.Dispose() } catch {}
    $process.Dispose()
  }
}
$script:uiaPromptResults = @{}
function Find-ValidatedPromptButton {
  param(
    [Parameter(Mandatory=$true)][IntPtr]$WindowHandle,
    [Parameter(Mandatory=$true)][string[]]$ExpectedMessages,
    [Parameter(Mandatory=$true)][string[]]$ExpectedDetails,
    [Parameter(Mandatory=$true)][string]$GoalStatusPrefix,
    [Parameter(Mandatory=$true)][string]$RequestedButton
  )
  $cacheKey = $WindowHandle.ToInt64().ToString()
  if (-not $script:uiaPromptResults.ContainsKey($cacheKey)) {
    $script:uiPhase = 'checking-accessible-prompt-body'
    $script:uiaPromptResults[$cacheKey] = Get-UiaPromptBodyResult $WindowHandle $ExpectedMessages $ExpectedDetails $GoalStatusPrefix
  }
  $script:uiPhase = 'checking-exact-dialog-buttons'
  $uiaResult = [string]$script:uiaPromptResults[$cacheKey]
  if ($uiaResult -match '^timeout-(phase-[a-z0-9-]+|no-phase)$') {
    $script:uiaPromptTimeoutPhase = $Matches[1]
    $uiaResult = 'timeout'
  }
  if ($uiaResult -match '^matched-([01])$') {
    return [TusWindowLookup]::FindExpectedQuitButton($WindowHandle, $ExpectedMessages, $RequestedButton, [int]$Matches[1])
  }
  switch ($uiaResult) {
    'mismatch' { [TusWindowLookup]::LastPromptStatus = 'expected-body-mismatch' }
    'timeout' { [TusWindowLookup]::LastPromptStatus = 'expected-body-timeout' }
    default { [TusWindowLookup]::LastPromptStatus = 'expected-body-unavailable' }
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
          $script:uiPhase = 'checking-exact-dialog-buttons'
          $quitButton = Find-ValidatedPromptButton $foregroundHandle $expectedMessages $expectedDetails $goalStatusPrefix $buttonName
          $promptStatus = [TusWindowLookup]::LastPromptStatus
          if ($quitButton -ne [IntPtr]::Zero) {
            Write-PromptEvidence
            Write-Output 'TUS_UIA: exact-foreground-prompt-matched'
            Write-Output 'TUS_UIA: dialog-accessible'
            $script:uiPhase = 'clicking-native-button'
            if (-not [TusWindowLookup]::ClickNativePromptButton($quitButton)) { Write-Output 'TUS_UIA: quit-button-click-failed'; exit 2 }
            Write-Output "Clicked native '$buttonName' button."
            exit 0
          }
        } else {
          $promptStatus = 'foreground-title-mismatch'
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
    $foregroundHandle = [TusWindowLookup]::GetForegroundWindow()
    if ($foregroundHandle -eq [IntPtr]::Zero -or [TusWindowLookup]::GetWindowTitle($foregroundHandle) -ne 'Codex activity may continue') {
      Write-Output 'TUS_UIA: expected-foreground-prompt-unavailable'
      exit 2
    }
    $button = Find-ValidatedPromptButton $foregroundHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
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
    $foregroundHandle = [TusWindowLookup]::GetForegroundWindow()
    if ($foregroundHandle -eq [IntPtr]::Zero -or [TusWindowLookup]::GetWindowTitle($foregroundHandle) -ne 'Codex activity may continue') {
      Write-Output 'TUS_UIA: expected-foreground-prompt-unavailable'
      exit 2
    }
    $button = Find-ValidatedPromptButton $foregroundHandle $expectedMessages $expectedDetails $goalStatusPrefix 'Keep the game open'
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
    $foregroundHandle = [TusWindowLookup]::GetForegroundWindow()
    if ($foregroundHandle -eq [IntPtr]::Zero -or [TusWindowLookup]::GetWindowTitle($foregroundHandle) -ne 'Codex activity may continue') {
      Write-Output 'TUS_UIA: test-prompt-not-found'
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
