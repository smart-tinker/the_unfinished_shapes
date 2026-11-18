$ErrorActionPreference = 'Stop'
function Write-ControlMarker {
  param([Parameter(Mandatory=$true)][string]$Marker)
  try {
    [Console]::Out.WriteLine('TUS_UIA_CONTROL: ' + $Marker)
    [Console]::Out.Flush()
  } catch {}
}
$childScript = @'
$null = [Console]::In.ReadLine()
Start-Sleep -Seconds 10
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
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public sealed class TusUiaWaitControlOutputCapture
{
    public readonly ManualResetEvent OutputReadComplete = new ManualResetEvent(false);
    public readonly DataReceivedEventHandler Handler;

    public TusUiaWaitControlOutputCapture()
    {
        Handler = new DataReceivedEventHandler(OnOutputDataReceived);
    }

    private void OnOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
    {
        if (eventArgs.Data == null)
        {
            try { OutputReadComplete.Set(); } catch (ObjectDisposedException) { }
        }
    }
}
'@
$outputCapture = New-Object TusUiaWaitControlOutputCapture
$process.add_OutputDataReceived($outputCapture.Handler)
$processStarted = $false
$waitCallReturned = $false
$waitTimedOut = $false
$waitWithinBound = $false
$killReturned = $false
$reapCompleted = $false
$processExited = $false
$drainObserved = $false
$drainComplete = $false
try {
  Write-ControlMarker 'control-start'
  if ($process.Start()) {
    $processStarted = $true
    Write-ControlMarker 'child-started'
    $process.BeginOutputReadLine()
    $process.StandardInput.WriteLine('control')
    $process.StandardInput.Close()
    Write-ControlMarker 'wait-started'
    $waitWatch = [Diagnostics.Stopwatch]::StartNew()
    try {
      $childExited = $process.WaitForExit(1000)
      $waitWatch.Stop()
      $waitCallReturned = $true
      Write-ControlMarker 'wait-returned'
      if ($waitWatch.ElapsedMilliseconds -lt 2500) {
        $waitWithinBound = $true
        Write-ControlMarker 'wait-within-bound'
      } else {
        Write-ControlMarker 'wait-over-bound'
      }
      if ($childExited) {
        Write-ControlMarker 'wait-child-exited'
      } else {
        $waitTimedOut = $true
        Write-ControlMarker 'wait-timed-out'
      }
    } catch {
      try { $waitWatch.Stop() } catch {}
      Write-ControlMarker 'wait-threw'
      throw
    }
  } else {
    Write-ControlMarker 'start-failed'
  }
} catch {
  Write-ControlMarker 'control-failed'
} finally {
  try {
    if ($processStarted -and -not $process.HasExited) {
      Write-ControlMarker 'kill-started'
      try {
        $process.Kill()
        $killReturned = $true
        Write-ControlMarker 'kill-returned'
      } catch {
        Write-ControlMarker 'kill-failed'
      }
      Write-ControlMarker 'reap-started'
      try {
        $reapCompleted = $process.WaitForExit(1000)
        if ($reapCompleted) { Write-ControlMarker 'reap-completed' }
        else { Write-ControlMarker 'reap-timed-out' }
      } catch {
        Write-ControlMarker 'reap-threw'
      }
    }
    if ($processStarted -and $process.HasExited) {
      $processExited = $true
      Write-ControlMarker 'process-exited'
      Write-ControlMarker 'stdout-eof-started'
      try {
        $drainComplete = $outputCapture.OutputReadComplete.WaitOne(0)
        $drainObserved = $true
        if ($drainComplete) { Write-ControlMarker 'stdout-eof-completed' }
        else { Write-ControlMarker 'stdout-eof-pending' }
      } catch {
        $drainObserved = $false
        Write-ControlMarker 'stdout-eof-threw'
      }
    } elseif ($processStarted) {
      Write-ControlMarker 'process-not-exited'
      Write-ControlMarker 'stdout-eof-skipped-process-not-exited'
    }
  } catch {
    Write-ControlMarker 'control-failed'
  }
  try { $process.remove_OutputDataReceived($outputCapture.Handler) } catch {}
  try { if ($drainComplete) { $outputCapture.OutputReadComplete.Dispose() } } catch {}
  try { $process.Dispose() } catch {}
}
if ($waitCallReturned -and $waitTimedOut -and $waitWithinBound -and
    $killReturned -and $reapCompleted -and $processExited -and $drainObserved) {
  Write-ControlMarker 'control-passed'
  exit 0
}
Write-ControlMarker 'control-failed'
exit 2
