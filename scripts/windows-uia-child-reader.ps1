function Get-UiaPromptBodyResult {
  param(
    [Parameter(Mandatory=$true)][IntPtr]$WindowHandle,
    [Parameter(Mandatory=$true)][string[]]$ExpectedMessages,
    [Parameter(Mandatory=$true)][string[]]$ExpectedDetails,
    [Parameter(Mandatory=$true)][string]$GoalStatusPrefix,
    [string]$ChildScriptOverride = ''
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
  if (-not [string]::IsNullOrEmpty($ChildScriptOverride)) { $childScript = $ChildScriptOverride }
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
  if ($null -eq ('TusUiaOutputCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Threading;
public sealed class TusUiaOutputCapture
{
    private static readonly Regex TokenMatcher = new Regex(@"^TUS_UIA_CHILD: (phase-(?:child-start|payload-read-(?:start|done)|payload-parse-(?:start|done)|payload-decode-(?:start|done)|payload-json-(?:start|done)|addtype-(?:types|client)-(?:start|done)|fromhandle-(?:start|done)|findfirst-\d+-(?:start|done)|current-name-\d+(?:-\d+)?-(?:start|done)|next-sibling-\d+-\d+-(?:start|done))|matched-[01]|mismatch)$", RegexOptions.CultureInvariant);
    public readonly List<string> Tokens = new List<string>();
    public readonly ManualResetEvent OutputReadComplete = new ManualResetEvent(false);
    public readonly DataReceivedEventHandler Handler;

    public TusUiaOutputCapture()
    {
        Handler = new DataReceivedEventHandler(OnOutputDataReceived);
    }

    private void OnOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
    {
        if (eventArgs.Data == null)
        {
            try { OutputReadComplete.Set(); } catch (ObjectDisposedException) { }
            return;
        }
        Match token = TokenMatcher.Match(eventArgs.Data);
        if (token.Success) Tokens.Add(token.Groups[1].Value);
    }
}
'@
  }
  $outputCapture = New-Object TusUiaOutputCapture
  $process.add_OutputDataReceived($outputCapture.Handler)
  $watch = [Diagnostics.Stopwatch]::StartNew()
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
    if (-not $process.Start()) { return 'unavailable' }
    Write-UiaPhaseMarker 'ui-child-started'
    $process.BeginOutputReadLine()
    Write-UiaPhaseMarker 'ui-payload-preparing'
    if ([string]::IsNullOrEmpty($ChildScriptOverride)) {
      $payload = ConvertTo-Json -InputObject @{
        handle = $WindowHandle.ToInt64(); expectedMessages = $ExpectedMessages
        expectedDetails = $ExpectedDetails; goalStatusPrefix = $GoalStatusPrefix
      } -Compress
      $payloadLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    } else {
      $payloadLine = 'synthetic-child-test'
    }
    Write-UiaPhaseMarker 'ui-payload-ready'
    Write-UiaPhaseMarker 'ui-payload-writing'
    $process.StandardInput.WriteLine($payloadLine)
    $process.StandardInput.Close()
    Write-UiaPhaseMarker 'ui-payload-written'
    $remaining = 6000 - [int]$watch.ElapsedMilliseconds
    Write-UiaPhaseMarker 'ui-child-waiting'
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
    if ($waitTimedOut) {
      Write-UiaPhaseMarker 'ui-child-killing'
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-started' }
      try {
        $process.Kill()
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-returned' }
      } catch {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'kill-failed' }
      }
      Write-UiaPhaseMarker 'ui-child-kill-waiting'
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'reap-started' }
      try {
        $reapCompleted = $process.WaitForExit(1000)
        if ($null -ne $testDiagnostic) {
          if ($reapCompleted) { & $testDiagnostic 'reap-completed' }
          else { & $testDiagnostic 'reap-timed-out' }
        }
      } catch {
        if ($null -ne $testDiagnostic) { & $testDiagnostic 'reap-threw' }
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
          try {
            $drainComplete = $outputCapture.OutputReadComplete.WaitOne($remaining)
          } catch {
            if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-threw' }
            throw
          }
          if ($null -ne $testDiagnostic) {
            if ($drainComplete) { & $testDiagnostic 'stdout-eof-completed' }
            else { & $testDiagnostic 'stdout-eof-timed-out' }
          }
        } elseif ($null -ne $testDiagnostic) {
          & $testDiagnostic 'stdout-eof-budget-expired'
        }
      } elseif ($null -ne $testDiagnostic) {
        & $testDiagnostic 'process-not-exited'
        & $testDiagnostic 'stdout-eof-skipped-process-not-exited'
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
      return 'unavailable'
    }
    if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-started' }
    try {
      $drainComplete = $outputCapture.OutputReadComplete.WaitOne($remaining)
    } catch {
      if ($null -ne $testDiagnostic) { & $testDiagnostic 'stdout-eof-threw' }
      throw
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
        $process.Kill()
        try { Write-UiaPhaseMarker 'ui-child-finally-waiting' } catch {}
        [void]$process.WaitForExit(1000)
      }
    } catch {}
    try { Write-UiaPhaseMarker 'ui-child-disposing' } catch {}
    try { $process.remove_OutputDataReceived($outputCapture.Handler) } catch {}
    try {
      if ($outputCapture.OutputReadComplete.WaitOne(0)) { $outputCapture.OutputReadComplete.Dispose() }
    } catch {}
    $process.Dispose()
  }
}
