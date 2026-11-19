param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$ExpectedInstallDir,
  [ValidateRange(30,180)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$script:installerProcessId = 0
$script:mainWindowHandle = [IntPtr]::Zero
$script:nativeWindowApiAvailable = $false
$nativeWindowApi = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TUSWindowApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
}
'@
try {
  Add-Type -TypeDefinition $nativeWindowApi -ErrorAction Stop | Out-Null
  $script:nativeWindowApiAvailable = $true
} catch {}
function Get-SafeControlCount {
  param([int]$Count)
  if ($Count -le 0) { return 'none' }
  if ($Count -eq 1) { return 'one' }
  if ($Count -eq 2) { return 'two' }
  return 'many'
}
function Get-DesktopName {
  param([uint32]$ThreadId)
  if (-not $script:nativeWindowApiAvailable -or $ThreadId -eq 0) { return $null }
  try {
    $desktop = [TUSWindowApi]::GetThreadDesktop($ThreadId)
    if ($desktop -eq [IntPtr]::Zero) { return $null }
    $buffer = [System.Text.StringBuilder]::new(128)
    $needed = 0
    if (-not [TUSWindowApi]::GetUserObjectInformation($desktop, 2, $buffer, $buffer.Capacity * 2, [ref]$needed)) { return $null }
    return $buffer.ToString()
  } catch { return $null }
}
function Get-Win32WindowSummary {
  param([int]$ProcessId, [IntPtr]$Handle)
  $result = [ordered]@{
    Foreground = 'unknown'; WindowClass = 'unknown'; NativeTitle = 'unknown'
    UiaProvider = 'unknown'; UiaDescendants = 'unknown'; Children = 'unknown'
    Buttons = 'unknown'; Static = 'unknown'; Session = 'unknown'
    Desktop = 'unknown'; Visible = 'unknown'
  }
  if (-not $script:nativeWindowApiAvailable -or $Handle -eq [IntPtr]::Zero) { return [pscustomobject]$result }
  try {
    $windowProcessId = [uint32]0
    $windowThreadId = [TUSWindowApi]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId)
    if ($windowThreadId -eq 0 -or $windowProcessId -ne $ProcessId) { return [pscustomobject]$result }

    $className = [System.Text.StringBuilder]::new(128)
    if ([TUSWindowApi]::GetClassName($Handle, $className, $className.Capacity) -gt 0) {
      $result.WindowClass = if ($className.ToString() -eq '#32770') { 'native-dialog' } else { 'other' }
    }
    $titleLength = [TUSWindowApi]::GetWindowTextLength($Handle)
    if ($titleLength -eq 0) { $result.NativeTitle = 'empty' }
    elseif ($titleLength -gt 256) { $result.NativeTitle = 'unknown' }
    else {
      $title = [System.Text.StringBuilder]::new(257)
      if ([TUSWindowApi]::GetWindowText($Handle, $title, $title.Capacity) -gt 0) {
        $result.NativeTitle = if ($title.ToString() -match '(?i)\b(error|failed|unable|cannot|could not)\b') { 'error-like' } else { 'other' }
      }
    }

    $foreground = [TUSWindowApi]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) { $result.Foreground = 'none' }
    else {
      $foregroundProcessId = [uint32]0
      [void][TUSWindowApi]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
      if ($foregroundProcessId -eq 0) { $result.Foreground = 'unknown' }
      elseif ($foregroundProcessId -eq $ProcessId) { $result.Foreground = 'installer' }
      else { $result.Foreground = 'other' }
    }
    $result.Visible = if ([TUSWindowApi]::IsWindowVisible($Handle)) { 'visible' } else { 'hidden' }

    $total = 0; $buttons = 0; $static = 0
    $child = [TUSWindowApi]::GetWindow($Handle, 5)
    while ($child -ne [IntPtr]::Zero -and $total -lt 128) {
      $total++
      $childClass = [System.Text.StringBuilder]::new(128)
      if ([TUSWindowApi]::GetClassName($child, $childClass, $childClass.Capacity) -gt 0) {
        if ($childClass.ToString() -eq 'Button') { $buttons++ }
        elseif ($childClass.ToString() -eq 'Static') { $static++ }
      }
      $child = [TUSWindowApi]::GetWindow($child, 2)
    }
    $result.Children = Get-SafeControlCount -Count $total
    $result.Buttons = Get-SafeControlCount -Count $buttons
    $result.Static = Get-SafeControlCount -Count $static

    $targetSession = (Get-Process -Id $ProcessId -ErrorAction Stop).SessionId
    $currentSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $result.Session = if ($targetSession -eq $currentSession) { 'match' } else { 'mismatch' }
    $windowDesktop = Get-DesktopName -ThreadId $windowThreadId
    $currentDesktop = Get-DesktopName -ThreadId ([TUSWindowApi]::GetCurrentThreadId())
    if ($null -ne $windowDesktop -and $null -ne $currentDesktop) {
      $result.Desktop = if ($windowDesktop -eq 'Default' -and $currentDesktop -eq 'Default') { 'default-interactive' } else { 'other' }
    }
  } catch {}
  return [pscustomobject]$result
}

function Get-WizardWindowSummary {
  param([int]$ProcessId, [IntPtr]$MainWindowHandle)
  $summary = [ordered]@{
    UiaTopLevel = 'unknown'; MainWindow = 'unknown'; WizardWindow = 'unknown'
    Foreground = 'unknown'; WindowClass = 'unknown'; NativeTitle = 'unknown'
    UiaProvider = 'unknown'; UiaDescendants = 'unknown'; Win32Children = 'unknown'
    Win32Buttons = 'unknown'; Win32Static = 'unknown'; Session = 'unknown'
    Desktop = 'unknown'; Visible = 'unknown'
  }
  try {
    $owner = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      $ProcessId)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      $owner)
    if ($null -eq $windows) { return [pscustomobject]$summary }
    $summary.UiaTopLevel = Get-SafeControlCount -Count $windows.Count
    $knownPages = @()
    $inspectionFailed = $false
    $mainWindowFound = $false
    $radioCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::RadioButton)
    $editCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)
    $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    $userSuffix = '(' + [Environment]::UserName + ')'
    foreach ($candidate in $windows) {
      try {
        if ($candidate.Current.ProcessId -ne $ProcessId) { continue }
        $handle = [IntPtr]$candidate.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        if ($MainWindowHandle -ne [IntPtr]::Zero -and $handle -eq $MainWindowHandle) {
          $mainWindowFound = $true
          $native = Get-Win32WindowSummary -ProcessId $ProcessId -Handle $MainWindowHandle
          $summary.Foreground = $native.Foreground
          $summary.WindowClass = $native.WindowClass
          $summary.NativeTitle = $native.NativeTitle
          $summary.Win32Children = $native.Children
          $summary.Win32Buttons = $native.Buttons
          $summary.Win32Static = $native.Static
          $summary.Session = $native.Session
          $summary.Desktop = $native.Desktop
          $summary.Visible = $native.Visible
          try {
            $children = $candidate.FindAll(
              [System.Windows.Automation.TreeScope]::Descendants,
              [System.Windows.Automation.Condition]::TrueCondition)
            $summary.UiaDescendants = Get-SafeControlCount -Count $children.Count
            $summary.UiaProvider = if ($children.Count -eq 0) { 'empty' } else { 'available' }
          } catch {
            $summary.UiaProvider = 'error'
            $summary.UiaDescendants = 'unknown'
            $inspectionFailed = $true
          }
        }
        if ($candidate.Current.IsOffscreen) { continue }
        $buttons = @($candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition))
        $edits = @($candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition))
        $radios = @($candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $radioCondition))
        $next = @($buttons | Where-Object { $_.Current.Name -eq 'Next >' -and $_.Current.IsEnabled })
        $install = @($buttons | Where-Object { $_.Current.Name -eq 'Install' -and $_.Current.IsEnabled })
        $finish = @($buttons | Where-Object { ($_.Current.Name -eq 'Finish' -or $_.Current.Name -eq 'Close') -and $_.Current.IsEnabled })
        $currentUserRadios = @($radios | Where-Object {
          ([string]$_.Current.Name).EndsWith($userSuffix, [StringComparison]::OrdinalIgnoreCase)
        })
        $installModePage = $radios.Count -ge 2 -and $currentUserRadios.Count -eq 1 -and $next.Count -eq 1
        $directoryPage = $edits.Count -eq 1 -and (
          ($next.Count -eq 1 -and $install.Count -eq 0) -or
          ($install.Count -eq 1 -and $next.Count -eq 0))
        $finishPage = $finish.Count -eq 1
        if ($installModePage -or $directoryPage -or $finishPage) { $knownPages += $handle }
      } catch {
        $inspectionFailed = $true
      }
    }
    if ($MainWindowHandle -eq [IntPtr]::Zero) { $summary.MainWindow = 'absent' }
    elseif ($mainWindowFound) { $summary.MainWindow = 'present' }
    elseif ($inspectionFailed) { $summary.MainWindow = 'unknown' }
    else { $summary.MainWindow = 'absent' }
    if ($inspectionFailed) { $summary.WizardWindow = 'unknown' }
    elseif ($knownPages.Count -gt 1) { $summary.WizardWindow = 'ambiguous' }
    elseif ($knownPages.Count -eq 1 -and $knownPages[0] -eq $MainWindowHandle) { $summary.WizardWindow = 'main' }
    elseif ($knownPages.Count -eq 1) { $summary.WizardWindow = 'other' }
    else { $summary.WizardWindow = 'none' }
  } catch {
    return [pscustomobject]$summary
  }
  return [pscustomobject]$summary
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
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$UiaTopLevel,
    [ValidateSet('present', 'absent', 'unknown')][string]$MainWindow,
    [ValidateSet('main', 'other', 'ambiguous', 'none', 'unknown')][string]$WizardWindow,
    [ValidateSet('installer', 'other', 'none', 'unknown')][string]$Foreground,
    [ValidateSet('native-dialog', 'other', 'unknown')][string]$WindowClass,
    [ValidateSet('error-like', 'other', 'empty', 'unknown')][string]$NativeTitle,
    [ValidateSet('empty', 'available', 'error', 'unknown')][string]$UiaProvider,
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$UiaDescendants,
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$Win32Children,
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$Win32Buttons,
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$Win32Static,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$Session,
    [ValidateSet('default-interactive', 'other', 'unknown')][string]$Desktop,
    [ValidateSet('visible', 'hidden', 'unknown')][string]$Visible,
    [ValidateRange(1, 2147483647)][int]$ProcessId
  )
  [Console]::Out.WriteLine("TUS_NSIS_WIZARD snapshot stage=$Stage process=path-match window=pid-match title=$Title mode=$Mode current-user=$CurrentUser radios=$Radios edits=$Edits next=$Next install=$Install finish=$Finish destination=$Destination uia-top-level=$UiaTopLevel main-window=$MainWindow wizard-window=$WizardWindow foreground=$Foreground window-class=$WindowClass native-title=$NativeTitle uia-provider=$UiaProvider uia-descendants=$UiaDescendants win32-children=$Win32Children win32-buttons=$Win32Buttons win32-static=$Win32Static session=$Session desktop=$Desktop visible=$Visible pid=$ProcessId")
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
  $script:mainWindowHandle = $handle
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
  $windowSummary = Get-WizardWindowSummary -ProcessId $script:installerProcessId -MainWindowHandle $script:mainWindowHandle
  Write-WizardSnapshot -Stage $snapshot.Stage -Title $snapshot.Title -Mode $snapshot.Mode -CurrentUser $snapshot.CurrentUser -Radios $snapshot.Radios -Edits $snapshot.Edits -Next $snapshot.Next -Install $snapshot.Install -Finish $snapshot.Finish -Destination $snapshot.Destination -UiaTopLevel $windowSummary.UiaTopLevel -MainWindow $windowSummary.MainWindow -WizardWindow $windowSummary.WizardWindow -Foreground $windowSummary.Foreground -WindowClass $windowSummary.WindowClass -NativeTitle $windowSummary.NativeTitle -UiaProvider $windowSummary.UiaProvider -UiaDescendants $windowSummary.UiaDescendants -Win32Children $windowSummary.Win32Children -Win32Buttons $windowSummary.Win32Buttons -Win32Static $windowSummary.Win32Static -Session $windowSummary.Session -Desktop $windowSummary.Desktop -Visible $windowSummary.Visible -ProcessId $script:installerProcessId
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
