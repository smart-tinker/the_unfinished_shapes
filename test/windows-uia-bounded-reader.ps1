$ErrorActionPreference = 'Stop'
function Write-UiaPhaseMarker {
  param([Parameter(Mandatory=$true)][string]$Phase)
  [Console]::Out.WriteLine('TUS_UIA: ' + $Phase)
  [Console]::Out.Flush()
}
. (Join-Path $PSScriptRoot '..\scripts\windows-uia-child-reader.ps1')
$testChildScript = @'
[Console]::Out.WriteLine('TUS_UIA_CHILD: phase-child-start')
[Console]::Out.Flush()
[Console]::Out.WriteLine('UNAPPROVED_PROMPT_TEST_PAYLOAD')
[Console]::Out.Flush()
[Console]::Out.WriteLine('TUS_UIA_CHILD: phase-unapproved-test-output')
[Console]::Out.Flush()
[Console]::Out.Write('TUS_UIA_CHILD: phase-payload-read-start-partial')
[Console]::Out.Flush()
Start-Sleep -Seconds 30
'@
$watch = [Diagnostics.Stopwatch]::StartNew()
$result = Get-UiaPromptBodyResult -WindowHandle ([IntPtr]::Zero) -ExpectedMessages @('fixture-message') -ExpectedDetails @('fixture-detail') -GoalStatusPrefix 'fixture-prefix' -ChildScriptOverride $testChildScript
$watch.Stop()
[Console]::Out.WriteLine("TUS_UIA_TEST: result=$result")
[Console]::Out.WriteLine("TUS_UIA_TEST: elapsed=$($watch.ElapsedMilliseconds)")
