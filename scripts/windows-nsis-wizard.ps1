param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$ExpectedInstallDir,
  [ValidateRange(30,180)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$script:installerProcessId = 0
function Get-SafeControlCount {
  param([int]$Count)
  if ($Count -le 0) { return 'none' }
  if ($Count -eq 1) { return 'one' }
  if ($Count -eq 2) { return 'two' }
  return 'many'
}
function Write-WizardSnapshot {
  param(
    [ValidateSet('entry', 'install-mode', 'directory', 'installing', 'finish', 'unknown')][string]$Stage,
    [ValidateSet('product-match', 'product-missing', 'unknown')][string]$Title,
    [ValidateSet('present', 'absent', 'unknown')][string]$Mode,
    [ValidateSet('selected', 'unselected', 'unknown')][string]$CurrentUser,
    [ValidateSet('none', 'one', 'two', 'many')][string]$Radios,
    [ValidateSet('none', 'one', 'many')][string]$Edits,
    [ValidateSet('match', 'missing')][string]$Next,
    [ValidateSet('match', 'missing')][string]$Install,
    [ValidateSet('match', 'missing')][string]$Finish,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$Destination,
    [ValidateRange(1, 2147483647)][int]$ProcessId
  )
  [Console]::Out.WriteLine("TUS_NSIS_WIZARD snapshot stage=$Stage process=path-match window=pid-match title=$Title mode=$Mode current-user=$CurrentUser radios=$Radios edits=$Edits next=$Next install=$Install finish=$Finish destination=$Destination pid=$ProcessId")
  [Console]::Out.Flush()
}

function Write-WizardEvent {
  param(
    [Parameter(Mandatory=$true)]
    [ValidateSet(
      'process-found', 'process-ambiguous', 'process-not-found',
      'window-found', 'window-not-found', 'window-mismatch',
      'install-mode-verified', 'install-mode-unavailable', 'directory-advanced', 'destination-entered', 'destination-verified', 'destination-unavailable', 'destination-mismatch',
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
$stage = 'entry'
$windowReported = $false
$finished = $false
$destinationVerified = $false
$destinationStatus = 'unknown'
$radioCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::RadioButton)
$editCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$normalizedExpectedDir = [System.IO.Path]::GetFullPath($expectedInstallDir).TrimEnd($trimCharacters)
$snapshot = [ordered]@{
  Stage = 'entry'; Title = 'unknown'; Mode = 'unknown'; CurrentUser = 'unknown'
  Radios = 'none'; Edits = 'none'; Next = 'missing'; Install = 'missing'
  Finish = 'missing'; Destination = 'unknown'
}
while ([DateTime]::UtcNow -lt $deadline) {
  $process = Get-Process -Id $script:installerProcessId -ErrorAction SilentlyContinue
  if (-not $process) {
    if ($stage -eq 'finish') { $finished = $true; break }
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
  $buttons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition))
  $edits = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition))
  $radios = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $radioCondition))
  $next = @($buttons | Where-Object { $_.Current.Name -eq 'Next >' -and $_.Current.IsEnabled })
  $install = @($buttons | Where-Object { $_.Current.Name -eq 'Install' -and $_.Current.IsEnabled })
  $finish = @($buttons | Where-Object { ($_.Current.Name -eq 'Finish' -or $_.Current.Name -eq 'Close') -and $_.Current.IsEnabled })
  $titleStatus = 'unknown'
  try {
    if ([String]::Equals([string]$window.Current.Name, 'The Unfinished Shapes', [StringComparison]::OrdinalIgnoreCase)) { $titleStatus = 'product-match' }
    else { $titleStatus = 'product-missing' }
  } catch {}
  $userSuffix = '(' + [Environment]::UserName + ')'
  $currentUserRadios = @($radios | Where-Object {
    ([string]$_.Current.Name).EndsWith($userSuffix, [StringComparison]::OrdinalIgnoreCase)
  })
  $modeStatus = 'unknown'
  if ($radios.Count -eq 0) { $modeStatus = 'absent' }
  elseif ($radios.Count -ge 2 -and $currentUserRadios.Count -eq 1) { $modeStatus = 'present' }
  $currentUserStatus = 'unknown'
  if ($currentUserRadios.Count -eq 1) {
    try {
      $selection = $currentUserRadios[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($selection.IsSelected) { $currentUserStatus = 'selected' } else { $currentUserStatus = 'unselected' }
    } catch {}
  }
  $nextStatus = 'missing'
  $installStatus = 'missing'
  $finishStatus = 'missing'
  if ($next.Count -eq 1) { $nextStatus = 'match' }
  if ($install.Count -eq 1) { $installStatus = 'match' }
  if ($finish.Count -eq 1) { $finishStatus = 'match' }
  $radioCountStatus = Get-SafeControlCount -Count $radios.Count
  $editCountStatus = Get-SafeControlCount -Count $edits.Count
  $snapshot = [ordered]@{
    Stage = $stage; Title = $titleStatus; Mode = $modeStatus; CurrentUser = $currentUserStatus
    Radios = $radioCountStatus
    Edits = $editCountStatus
    Next = $nextStatus; Install = $installStatus; Finish = $finishStatus
    Destination = $destinationStatus
  }

  if ($stage -eq 'entry') {
    if ($modeStatus -eq 'present') {
      $stage = 'install-mode'
      $snapshot.Stage = $stage
      if ($currentUserRadios.Count -ne 1) {
        Write-WizardEvent -Name 'install-mode-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      try {
        $selection = $currentUserRadios[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $selection.IsSelected) { $selection.Select() }
        $currentUserSelected = $currentUserRadios[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).IsSelected
      } catch {
        Write-WizardEvent -Name 'install-mode-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      if (-not $currentUserSelected) {
        Write-WizardEvent -Name 'install-mode-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      $snapshot.CurrentUser = 'selected'
      if ($next.Count -ne 1) { Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId; exit 2 }
      $next[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'install-mode-verified' -ProcessId $script:installerProcessId
      $stage = 'directory'
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($modeStatus -eq 'unknown') { Start-Sleep -Milliseconds 100; continue }
    if ($edits.Count -eq 1) { $stage = 'directory'; $snapshot.Stage = $stage }
    elseif ($edits.Count -gt 1) { Write-WizardEvent -Name 'destination-unavailable' -ProcessId $script:installerProcessId; exit 2 }
    else {
      if ($finish.Count -eq 1) {
        $finish[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-WizardEvent -Name 'finish-clicked' -ProcessId $script:installerProcessId
        $stage = 'finish'
        Start-Sleep -Milliseconds 100
        continue
      }
      Start-Sleep -Milliseconds 100
      continue
    }
  }

  if ($stage -eq 'directory') {
    if ($edits.Count -eq 0) {
      # The pinned updater may skip Directory; the source was installed at this same expected path.
      if ($finish.Count -eq 1) {
        $finish[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-WizardEvent -Name 'finish-clicked' -ProcessId $script:installerProcessId
        $stage = 'finish'
        Start-Sleep -Milliseconds 100
        continue
      }
      Start-Sleep -Milliseconds 100
      continue
    }
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
      $destinationStatus = 'mismatch'
      Write-WizardEvent -Name 'destination-mismatch' -ProcessId $script:installerProcessId
      exit 2
    }
    $destinationVerified = $true
    $destinationStatus = 'match'
    Write-WizardEvent -Name 'destination-verified' -ProcessId $script:installerProcessId
    if ($next.Count -eq 1 -and $install.Count -eq 0) {
      $next[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'directory-advanced' -ProcessId $script:installerProcessId
      $stage = 'installing'
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($install.Count -eq 1 -and $next.Count -eq 0) {
      $install[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'install-started' -ProcessId $script:installerProcessId
      $stage = 'installing'
      Start-Sleep -Milliseconds 100
      continue
    }
    Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId
    exit 2
  }

  if ($stage -eq 'installing') {
    if ($install.Count -eq 1 -and $destinationVerified) {
      $install[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'install-started' -ProcessId $script:installerProcessId
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($finish.Count -eq 1) {
      $finish[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'finish-clicked' -ProcessId $script:installerProcessId
      $stage = 'finish'
      Start-Sleep -Milliseconds 100
      continue
    }
  }
  Start-Sleep -Milliseconds 100
}
if (-not $finished) {
  if (-not $windowReported) { Write-WizardEvent -Name 'window-not-found' -ProcessId $script:installerProcessId }
  if ($windowReported) {
    Write-WizardSnapshot -Stage $snapshot.Stage -Title $snapshot.Title -Mode $snapshot.Mode -CurrentUser $snapshot.CurrentUser -Radios $snapshot.Radios -Edits $snapshot.Edits -Next $snapshot.Next -Install $snapshot.Install -Finish $snapshot.Finish -Destination $snapshot.Destination -ProcessId $script:installerProcessId
  }
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
