function Get-UiaPromptBodyResult {
  param(
    [Parameter(Mandatory=$true)][IntPtr]$WindowHandle,
    [Parameter(Mandatory=$true)][string[]]$ExpectedMessages,
    [Parameter(Mandatory=$true)][string[]]$ExpectedDetails,
    [Parameter(Mandatory=$true)][string]$GoalStatusPrefix,
    [string]$ChildScriptOverride = '',
    [Parameter(Mandatory=$true)][int]$ExpectedProcessId,
    [Parameter(Mandatory=$true)][string]$ExpectedOwnerHandle,
    [ValidateSet('STA','MTA')][string]$Apartment = 'MTA'
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
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-decode-start')
  [Console]::Out.Flush()
  $payloadJson = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payloadLine))
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-decode-done')
  [Console]::Out.Flush()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-json-start')
  [Console]::Out.Flush()
  $payload = ConvertFrom-Json -InputObject $payloadJson
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-payload-json-done')
  [Console]::Out.Flush()
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
  $elements = @()
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-first-child-start')
  [Console]::Out.Flush()
  $element = $walker.GetFirstChild($root)
  [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-first-child-done')
  [Console]::Out.Flush()
  # shortcut: 64 direct children, raise only if packaged evidence exceeds this bound.
  for ($childOrdinal = 0; $null -ne $element -and $childOrdinal -lt 64; $childOrdinal++) {
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-child-name-start')
    [Console]::Out.Flush()
    $elementName = [string]$element.GetCurrentPropertyValue(
      [System.Windows.Automation.AutomationElement]::NameProperty)
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-child-name-done')
    [Console]::Out.Flush()
    $elements += [pscustomobject]@{ Element = $element; Name = $elementName }
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-next-sibling-start')
    [Console]::Out.Flush()
    $nextElement = $walker.GetNextSibling($element)
    [Console]::Out.WriteLine('TUS_UIA_CHILD: phase-next-sibling-done')
    [Console]::Out.Flush()
    if ($childOrdinal -eq 63) {
      if ($null -ne $nextElement) {
        [Console]::Out.WriteLine('unavailable')
        exit 1
      }
      break
    }
    $element = $nextElement
  }
  for ($index = 0; $index -lt $expected.Length; $index++) {
    $messageChildIndex = -1
    for ($childIndex = 0; $childIndex -lt $elements.Count; $childIndex++) {
      if ([string]::Equals([string]$elements[$childIndex].Name, [string]$expected[$index], [StringComparison]::Ordinal)) {
        $messageChildIndex = $childIndex
        break
      }
    }
    if ($messageChildIndex -lt 0) { continue }
    for ($detailIndex = $messageChildIndex + 1;
         $detailIndex -lt ($messageChildIndex + 9) -and $detailIndex -lt $elements.Count;
         $detailIndex++) {
      if (Test-ExpectedPromptDetail $index ([string]$elements[$detailIndex].Name)) {
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
  if (-not [string]::IsNullOrEmpty($ChildScriptOverride)) { $childScript = $ChildScriptOverride }
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
  $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -' + $Apartment + ' -EncodedCommand ' + $encodedScript
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  function Write-UiaTimingMarker {
    param(
      [Parameter(Mandatory=$true)]
      [ValidateSet('reader-setup','process-start','fromhandle','payload-encode','payload-write','reader-wait','child-kill','child-reap','output-drain','child-finally-kill','child-finally-reap')]
      [string]$Phase,
      [Parameter(Mandatory=$true)][long]$Milliseconds
    )
    if ($Milliseconds -lt 0 -or $Milliseconds -gt 999999) { return }
    try {
      [Console]::Out.WriteLine('TUS_UIA_TIMING: ' + $Phase + '-ms=' + $Milliseconds)
      [Console]::Out.Flush()
    } catch {}
  }
  $setupWatch = [Diagnostics.Stopwatch]::StartNew()
  if ($null -eq ('TusUiaOutputCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Threading;
public sealed class TusUiaOutputCapture
{
    private static readonly Regex TokenMatcher = new Regex(@"^TUS_UIA_CHILD: (phase-(?:child-start|payload-read-(?:start|done)|payload-parse-(?:start|done)|payload-decode-(?:start|done)|payload-json-(?:start|done)|addtype-(?:types|client)-(?:start|done)|fromhandle-(?:start|done)|first-child-(?:start|done)|child-name-(?:start|done)|next-sibling-(?:start|done))|matched-[01]|mismatch)$", RegexOptions.CultureInvariant);
    public readonly List<string> Tokens = new List<string>();
    private Stopwatch fromHandleWatch;
    private readonly int expectedProcessId;
    private readonly string expectedOwnerHandle;
    private readonly Stopwatch probeBudgetWatch = Stopwatch.StartNew();
    private int ownerProbeQueued;
    private volatile bool fromHandleObserved;
    private volatile bool fromHandleDone;
    private volatile bool ownerProbeComplete;
    private volatile string ownerProbeStatus = "unknown";
    public bool FromHandleObserved { get { return fromHandleObserved; } }
    public string OwnerWindowProbeStatus
    {
        get { return ownerProbeComplete &&
            (ownerProbeStatus == "responsive" || ownerProbeStatus == "timeout") ? ownerProbeStatus : "unknown"; }
    }
    public long FromHandleMilliseconds
    {
        get { return fromHandleWatch == null || fromHandleWatch.IsRunning ? -1 : fromHandleWatch.ElapsedMilliseconds; }
    }
    public readonly ManualResetEvent OutputReadComplete = new ManualResetEvent(false);
    public readonly DataReceivedEventHandler Handler;

    public TusUiaOutputCapture(int processId, string ownerWindowHandle)
    {
        expectedProcessId = processId;
        expectedOwnerHandle = ownerWindowHandle;
        Handler = new DataReceivedEventHandler(OnOutputDataReceived);
    }

    private void ProbeOwnerWindow(object state)
    {
        string status = "unknown";
        try
        {
            // Let the child enter FromHandle after its flushed start marker.
            Thread.Sleep(10);
            int remaining = 6500 - (int)probeBudgetWatch.ElapsedMilliseconds - 50;
            if (!fromHandleDone && remaining > 0)
            {
                uint timeout = (uint)Math.Min(250, remaining);
                status = TusWindowLookup.ProbeExpectedOwnerWindow(expectedProcessId, expectedOwnerHandle, timeout);
                if (fromHandleDone) status = "unknown";
            }
        }
        catch { status = "unknown"; }
        ownerProbeStatus = status == "responsive" || status == "timeout" ? status : "unknown";
        ownerProbeComplete = true;
    }

    private void OnOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
    {
        if (eventArgs.Data == null)
        {
            try { OutputReadComplete.Set(); } catch (ObjectDisposedException) { }
            return;
        }
        Match token = TokenMatcher.Match(eventArgs.Data);
        if (token.Success)
        {
            string value = token.Groups[1].Value;
            Tokens.Add(value);
            if (value == "phase-fromhandle-start")
            {
                fromHandleWatch = Stopwatch.StartNew();
                fromHandleObserved = true;
                if (Interlocked.Exchange(ref ownerProbeQueued, 1) == 0)
                {
                    try
                    {
                        if (!ThreadPool.QueueUserWorkItem(ProbeOwnerWindow)) ownerProbeComplete = true;
                    }
                    catch { ownerProbeComplete = true; }
                }
            }
            else if (value == "phase-fromhandle-done")
            {
                fromHandleDone = true;
                if (fromHandleWatch != null) fromHandleWatch.Stop();
            }
        }
    }
}
'@
  }
  $outputCapture = New-Object -TypeName TusUiaOutputCapture -ArgumentList @($ExpectedProcessId, $ExpectedOwnerHandle)
  $process.add_OutputDataReceived($outputCapture.Handler)
  $setupWatch.Stop()
  Write-UiaTimingMarker 'reader-setup' $setupWatch.ElapsedMilliseconds
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $phaseWatch = [Diagnostics.Stopwatch]::StartNew()
  $phaseWatch.Stop()
  $testDiagnostic = $null
  if (-not [string]::IsNullOrEmpty($ChildScriptOverride)) {
    $testDiagnostic = {
      param([string]$Marker)
      try {
        [Console]::Out.WriteLine('TUS_UIA_DIAG: ' + $Marker)
        [Console]::Out.Flush()
      } catch {}
    }
  }
  try {
    if ($null -ne $testDiagnostic) { & $testDiagnostic 'diagnostic-enabled' }
    Write-UiaPhaseMarker 'ui-child-starting'
    $phaseWatch.Restart()
    $started = $false
    try { $started = $process.Start() } finally {
      $phaseWatch.Stop()
      Write-UiaTimingMarker 'process-start' $phaseWatch.ElapsedMilliseconds
    }
    if (-not $started) { return 'unavailable' }
    Write-UiaPhaseMarker 'ui-child-started'
    $process.BeginOutputReadLine()
    Write-UiaPhaseMarker 'ui-payload-preparing'
    $phaseWatch.Restart()
    if ([string]::IsNullOrEmpty($ChildScriptOverride)) {
      $payload = ConvertTo-Json -InputObject @{
        handle = $WindowHandle.ToInt64(); expectedMessages = $ExpectedMessages
        expectedDetails = $ExpectedDetails; goalStatusPrefix = $GoalStatusPrefix
      } -Compress
      $payloadLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    } else {
      $payloadLine = 'synthetic-child-test'
    }
    $phaseWatch.Stop()
    Write-UiaTimingMarker 'payload-encode' $phaseWatch.ElapsedMilliseconds
    Write-UiaPhaseMarker 'ui-payload-ready'
    Write-UiaPhaseMarker 'ui-payload-writing'
    $phaseWatch.Restart()
    $process.StandardInput.WriteLine($payloadLine)
    $process.StandardInput.Close()
    $phaseWatch.Stop()
    Write-UiaTimingMarker 'payload-write' $phaseWatch.ElapsedMilliseconds
    Write-UiaPhaseMarker 'ui-payload-written'
    $remaining = 6500 - [int]$watch.ElapsedMilliseconds
    Write-UiaPhaseMarker 'ui-child-waiting'
    $phaseWatch.Restart()
    try {
      if ($remaining -le 0) {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'wait-budget-expired' }
        $waitTimedOut = $true
      } else {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'wait-started' }
        try {
          $waitTimedOut = -not $process.WaitForExit($remaining)
        } catch {
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'wait-threw' }
          throw
        }
        if ($null -ne $testDiagnostic) {
          if ($waitTimedOut) { & $testDiagnostic 'wait-timed-out' }
          else { & $testDiagnostic 'wait-child-exited' }
        }
      }
    } finally {
      $phaseWatch.Stop()
      Write-UiaTimingMarker 'reader-wait' $phaseWatch.ElapsedMilliseconds
    }
    if ($waitTimedOut) {
      Write-UiaPhaseMarker 'ui-child-killing'
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-started' }
      $phaseWatch.Restart()
      try {
        try {
          $process.Kill()
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-returned' }
        } catch {
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-failed' }
        }
      } finally {
        $phaseWatch.Stop()
        Write-UiaTimingMarker 'child-kill' $phaseWatch.ElapsedMilliseconds
      }
      Write-UiaPhaseMarker 'ui-child-kill-waiting'
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'reap-started' }
      $phaseWatch.Restart()
      try {
        try {
          $reapCompleted = $process.WaitForExit(1000)
          if ($null -ne $testDiagnostic) {
            if ($reapCompleted) { & $testDiagnostic 'reap-completed' }
            else { & $testDiagnostic 'reap-timed-out' }
          }
        } catch {
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'reap-threw' }
        }
      } finally {
        $phaseWatch.Stop()
        Write-UiaTimingMarker 'child-reap' $phaseWatch.ElapsedMilliseconds
      }
      Write-UiaPhaseMarker 'ui-child-exit-checking'
      $drainComplete = $false
      if ($process.HasExited) {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'process-exited' }
        Write-UiaPhaseMarker 'ui-child-output-draining'
        $watch.Restart()
        $remaining = 1000 - [int]$watch.ElapsedMilliseconds
        if ($remaining -gt 0) {
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-started' }
          $phaseWatch.Restart()
          try {
            try {
              $drainComplete = $outputCapture.OutputReadComplete.WaitOne($remaining)
            } catch {
              if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-threw' }
              throw
            }
          } finally {
            $phaseWatch.Stop()
            Write-UiaTimingMarker 'output-drain' $phaseWatch.ElapsedMilliseconds
          }
          if ($null -ne $testDiagnostic) {
            if ($drainComplete) { & $testDiagnostic 'stdout-eof-completed' }
            else { & $testDiagnostic 'stdout-eof-timed-out' }
          }
        } else {
          if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-budget-expired' }
          Write-UiaTimingMarker 'output-drain' $watch.ElapsedMilliseconds
        }
      } else {
        if ($null -ne $testDiagnostic) {
          & $testDiagnostic 'process-not-exited'
          & $testDiagnostic 'stdout-eof-skipped-process-not-exited'
        }
        Write-UiaTimingMarker 'output-drain' 0
      }
      if (-not $drainComplete) { return 'timeout-no-phase' }
      $phases = @($outputCapture.Tokens.ToArray() | Where-Object { $_ -match '^phase-' })
      if ($phases.Count -gt 0) { return 'timeout-' + $phases[$phases.Count - 1] }
      return 'timeout-no-phase'
    }
    Write-UiaPhaseMarker 'ui-child-output-draining'
    $watch.Restart()
    $remaining = 1000 - [int]$watch.ElapsedMilliseconds
    if ($remaining -le 0) {
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-budget-expired' }
      Write-UiaTimingMarker 'output-drain' $watch.ElapsedMilliseconds
      return 'unavailable'
    }
    if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-started' }
    $phaseWatch.Restart()
    try {
      try {
        $drainComplete = $outputCapture.OutputReadComplete.WaitOne($remaining)
      } catch {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-threw' }
        throw
      }
    } finally {
      $phaseWatch.Stop()
      Write-UiaTimingMarker 'output-drain' $phaseWatch.ElapsedMilliseconds
    }
    if (-not $drainComplete) {
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-timed-out' }
      return 'unavailable'
    }
    if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-completed' }
    Write-UiaPhaseMarker 'ui-child-finished'
    $results = @($outputCapture.Tokens.ToArray() | Where-Object { $_ -match '^(matched-[01]|mismatch|unavailable)$' })
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
        $phaseWatch.Restart()
        try { $process.Kill() } finally {
          $phaseWatch.Stop()
          Write-UiaTimingMarker 'child-finally-kill' $phaseWatch.ElapsedMilliseconds
        }
        try { Write-UiaPhaseMarker 'ui-child-finally-waiting' } catch {}
        $phaseWatch.Restart()
        try { [void]$process.WaitForExit(1000) } finally {
          $phaseWatch.Stop()
          Write-UiaTimingMarker 'child-finally-reap' $phaseWatch.ElapsedMilliseconds
        }
      }
    } catch {}
    try {
      if ($outputCapture.FromHandleObserved) {
        [Console]::Out.WriteLine('TUS_UIA_DIAG: owner-window-wm-null=' + $outputCapture.OwnerWindowProbeStatus)
        [Console]::Out.Flush()
      }
    } catch {}
    try {
      $fromHandleMilliseconds = $outputCapture.FromHandleMilliseconds
      if ($fromHandleMilliseconds -ge 0) { Write-UiaTimingMarker 'fromhandle' $fromHandleMilliseconds }
    } catch {}
    try { Write-UiaPhaseMarker 'ui-child-disposing' } catch {}
    try { $process.remove_OutputDataReceived($outputCapture.Handler) } catch {}
    try {
      if ($outputCapture.OutputReadComplete.WaitOne(0)) { $outputCapture.OutputReadComplete.Dispose() }
    } catch {}
    $process.Dispose()
  }
}
