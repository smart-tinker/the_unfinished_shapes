param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$ExpectedInstallDir,
  [ValidateRange(30,180)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$script:installerProcessId = 0
function Write-WizardEvent {
  param(
    [Parameter(Mandatory=$true)]
    [ValidateSet(
      'process-found', 'process-ambiguous', 'process-not-found',
      'window-found', 'window-not-found', 'window-mismatch',
      'welcome-advanced', 'destination-entered', 'destination-verified', 'destination-unavailable', 'destination-mismatch',
      'next-unavailable', 'install-started', 'finish-clicked', 'installer-exited',
      'installer-exited-early', 'installed-executable-missing', 'completed',
      'timeout', 'uia-unavailable', 'automation-failed'
    )]
    [string]$Name,
    [int]$ProcessId = 0
  )
  if ($ProcessId -gt 0) { [Console]::Out.WriteLine("TUS_NSIS_WIZARD event=$Name pid=$ProcessId") }
  else { [Console]::Out.WriteLine("TUS_NSIS_WIZARD event=$Name") }
  [Console]::Out.Flush()
}
trap {
  Write-WizardEvent -Name 'automation-failed' -ProcessId $script:installerProcessId
  exit 2
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Write-WizardEvent -Name 'uia-unavailable'
  exit 2
}
try {
  $installerPath = [System.IO.Path]::GetFullPath($InstallerPath)
  $expectedInstallDir = [System.IO.Path]::GetFullPath($ExpectedInstallDir)
} catch {
  Write-WizardEvent -Name 'automation-failed'
  exit 2
}
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$process = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $process) {
  $matchedProcesses = @()
  foreach ($candidate in [Diagnostics.Process]::GetProcesses()) {
    try {
      $candidate.Refresh()
      $candidatePath = [System.IO.Path]::GetFullPath($candidate.MainModule.FileName)
      if ([String]::Equals($candidatePath, $installerPath, [StringComparison]::OrdinalIgnoreCase)) {
        $matchedProcesses += $candidate
      }
    } catch {}
  }
  if ($matchedProcesses.Count -gt 1) {
    Write-WizardEvent -Name 'process-ambiguous'
    exit 2
  }
  if ($matchedProcesses.Count -eq 1) { $process = $matchedProcesses[0] }
  else { Start-Sleep -Milliseconds 100 }
}
if (-not $process) {
  Write-WizardEvent -Name 'process-not-found'
  exit 2
}
$script:installerProcessId = $process.Id
Write-WizardEvent -Name 'process-found' -ProcessId $script:installerProcessId
$stage = 'welcome'
$windowReported = $false
$finished = $false
$textCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Text)
$editCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$normalizedExpectedDir = [System.IO.Path]::GetFullPath($expectedInstallDir).TrimEnd($trimCharacters)
while ([DateTime]::UtcNow -lt $deadline) {
  $process = Get-Process -Id $script:installerProcessId -ErrorAction SilentlyContinue
  if (-not $process) {
    if ($stage -eq 'finish-clicked') { $finished = $true; break }
    Write-WizardEvent -Name 'installer-exited-early' -ProcessId $script:installerProcessId
    exit 2
  }
  $process.Refresh()
  $handle = $process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100; continue }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($null -eq $window -or $window.Current.ProcessId -ne $script:installerProcessId) {
    Write-WizardEvent -Name 'window-mismatch' -ProcessId $script:installerProcessId
    exit 2
  }
  if (-not $windowReported) {
    Write-WizardEvent -Name 'window-found' -ProcessId $script:installerProcessId
    $windowReported = $true
  }
  $texts = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition))
  $buttons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition))
  if ($stage -eq 'welcome') {
    $welcome = $false
    foreach ($item in $texts) {
      $name = [string]$item.Current.Name
      if ($name -match '(?i)welcome' -and $name -match '(?i)The Unfinished Shapes') { $welcome = $true; break }
    }
    if (-not $welcome) { Start-Sleep -Milliseconds 100; continue }
    $next = @($buttons | Where-Object { $_.Current.Name -eq 'Next >' -and $_.Current.IsEnabled })
    if ($next.Count -ne 1) { Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId; exit 2 }
    $next[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-WizardEvent -Name 'welcome-advanced' -ProcessId $script:installerProcessId
    $stage = 'directory'
    Start-Sleep -Milliseconds 100
    continue
  }
  if ($stage -eq 'directory') {
    $edits = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition))
    if ($edits.Count -eq 0) { Start-Sleep -Milliseconds 100; continue }
    if ($edits.Count -ne 1) { Write-WizardEvent -Name 'destination-unavailable' -ProcessId $script:installerProcessId; exit 2 }
    try {
      if (-not $edits[0].Current.IsEnabled) { throw 'disabled' }
      $valuePattern = $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $valuePattern.SetValue($expectedInstallDir)
      Write-WizardEvent -Name 'destination-entered' -ProcessId $script:installerProcessId
      $value = [string]$valuePattern.Current.Value
      $normalizedValue = [System.IO.Path]::GetFullPath($value).TrimEnd($trimCharacters)
    } catch {
      Write-WizardEvent -Name 'destination-unavailable' -ProcessId $script:installerProcessId
      exit 2
    }
    if (-not [String]::Equals($normalizedValue, $normalizedExpectedDir, [StringComparison]::OrdinalIgnoreCase)) {
      Write-WizardEvent -Name 'destination-mismatch' -ProcessId $script:installerProcessId
      exit 2
    }
    Write-WizardEvent -Name 'destination-verified' -ProcessId $script:installerProcessId
    $next = @($buttons | Where-Object { $_.Current.Name -eq 'Next >' -and $_.Current.IsEnabled })
    if ($next.Count -ne 1) { Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId; exit 2 }
    $next[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $stage = 'install'
    Start-Sleep -Milliseconds 100
    continue
  }
  if ($stage -eq 'install') {
    $install = @($buttons | Where-Object { $_.Current.Name -eq 'Install' -and $_.Current.IsEnabled })
    if ($install.Count -ne 1) { Start-Sleep -Milliseconds 100; continue }
    $install[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-WizardEvent -Name 'install-started' -ProcessId $script:installerProcessId
    $stage = 'installing'
    Start-Sleep -Milliseconds 100
    continue
  }
  if ($stage -eq 'installing') {
    $finish = @($buttons | Where-Object { ($_.Current.Name -eq 'Finish' -or $_.Current.Name -eq 'Close') -and $_.Current.IsEnabled })
    if ($finish.Count -ne 1) { Start-Sleep -Milliseconds 100; continue }
    $finish[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-WizardEvent -Name 'finish-clicked' -ProcessId $script:installerProcessId
    $stage = 'finish-clicked'
    Start-Sleep -Milliseconds 100
    continue
  }
  Start-Sleep -Milliseconds 100
}
if (-not $finished) {
  if (-not $windowReported) { Write-WizardEvent -Name 'window-not-found' -ProcessId $script:installerProcessId }
  Write-WizardEvent -Name 'timeout' -ProcessId $script:installerProcessId
  Stop-Process -Id $script:installerProcessId -Force -ErrorAction SilentlyContinue
  exit 2
}
Write-WizardEvent -Name 'installer-exited' -ProcessId $script:installerProcessId
if (-not (Test-Path -LiteralPath (Join-Path $expectedInstallDir 'TheUnfinishedShapes.exe') -PathType Leaf)) {
  Write-WizardEvent -Name 'installed-executable-missing' -ProcessId $script:installerProcessId
  exit 2
}
Write-WizardEvent -Name 'completed' -ProcessId $script:installerProcessId
