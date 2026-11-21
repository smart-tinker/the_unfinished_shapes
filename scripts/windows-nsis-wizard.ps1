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
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
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
function Get-NativeControlStatus {
  param([IntPtr]$Window, [int]$ControlId, [string]$ExpectedClass)
  if (-not $script:nativeWindowApiAvailable -or $Window -eq [IntPtr]::Zero) { return 'unknown' }
  try {
    $control = [TUSWindowApi]::GetDlgItem($Window, $ControlId)
    if ($control -eq [IntPtr]::Zero) { return 'missing' }
    $className = [System.Text.StringBuilder]::new(128)
    if ([TUSWindowApi]::GetClassName($control, $className, $className.Capacity) -le 0) { return 'unknown' }
    if ($className.ToString() -eq $ExpectedClass) { return 'match' }
    return 'wrong-class'
  } catch { return 'unknown' }
}
function Get-NativeRadioSelection {
  param([IntPtr]$Handle, [int]$ProcessId, [IntPtr]$PageHandle)
  if (-not $script:nativeWindowApiAvailable -or $Handle -eq [IntPtr]::Zero -or $PageHandle -eq [IntPtr]::Zero) { return 'unknown' }
  try {
    $controlProcessId = [uint32]0
    $threadId = [TUSWindowApi]::GetWindowThreadProcessId($Handle, [ref]$controlProcessId)
    if ($threadId -eq 0 -or [TUSWindowApi]::GetParent($Handle) -ne $PageHandle -or $controlProcessId -ne $ProcessId) { return 'unknown' }
    $className = [System.Text.StringBuilder]::new(128)
    if ([TUSWindowApi]::GetClassName($Handle, $className, $className.Capacity) -le 0 -or $className.ToString() -ne 'Button') { return 'unknown' }
    if (([TUSWindowApi]::GetWindowLong($Handle, -16) -band 0x0f) -ne 9) { return 'unknown' }
    $value = [IntPtr]::Zero
    $sent = [TUSWindowApi]::SendMessageTimeout($Handle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 500, [ref]$value)
    if ($sent -eq [IntPtr]::Zero) { return 'unknown' }
    if ($value.ToInt64() -eq 0) { return 'unselected' }
    if ($value.ToInt64() -eq 1) { return 'selected' }
  } catch {}
  return 'unknown'
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
function Get-OptionNextControl {
  param([int]$ProcessId, [IntPtr]$MainWindowHandle)
  $result = [ordered]@{ Handle = [IntPtr]::Zero; Status = 'unknown' }
  if (-not $script:nativeWindowApiAvailable -or $MainWindowHandle -eq [IntPtr]::Zero) { return [pscustomobject]$result }
  try {
    $mainWindowProcessId = [uint32]0
    $mainWindowThreadId = [TUSWindowApi]::GetWindowThreadProcessId($MainWindowHandle, [ref]$mainWindowProcessId)
    if ($mainWindowThreadId -eq 0 -or $mainWindowProcessId -ne $ProcessId) { $result.Status = 'owner-mismatch'; return [pscustomobject]$result }
    $control = [TUSWindowApi]::GetDlgItem($MainWindowHandle, 1)
    $result.Handle = $control
    if ($control -eq [IntPtr]::Zero) { $result.Status = 'missing'; return [pscustomobject]$result }
    $controlProcessId = [uint32]0
    $threadId = [TUSWindowApi]::GetWindowThreadProcessId($control, [ref]$controlProcessId)
    if ($threadId -eq 0) { return [pscustomobject]$result }
    if ([TUSWindowApi]::GetParent($control) -ne $MainWindowHandle -or $controlProcessId -ne $ProcessId) {
      $result.Status = 'owner-mismatch'
      return [pscustomobject]$result
    }
    $className = [System.Text.StringBuilder]::new(128)
    if ([TUSWindowApi]::GetClassName($control, $className, $className.Capacity) -le 0) { return [pscustomobject]$result }
    if ($className.ToString() -ne 'Button') { $result.Status = 'wrong-class'; return [pscustomobject]$result }
    if (-not [TUSWindowApi]::IsWindowVisible($control)) { $result.Status = 'hidden'; return [pscustomobject]$result }
    if (-not [TUSWindowApi]::IsWindowEnabled($control)) { $result.Status = 'disabled'; return [pscustomobject]$result }
    $result.Status = 'match'
  } catch {}
  return [pscustomobject]$result
}
function Get-NsisPageSummary {
  param([int]$ProcessId, [IntPtr]$MainWindowHandle)
  $result = [ordered]@{
    Handle = [IntPtr]::Zero; PageWindow = 'unknown'; PageParent = 'unknown'; PageProcess = 'unknown'
    PageVisible = 'unknown'; PageClass = 'unknown'; NativePage = 'unknown'
    DirectoryEdit = 'unknown'; DirectoryBrowse = 'unknown'; DirectoryText = 'unknown'; InstallProgress = 'unknown'
    OptionPage = 'unknown'; OptionRadioCount = 'unknown'; OptionRadioStyle = 'unknown'; OptionNext = 'unknown'
    OptionNextHandle = [IntPtr]::Zero; CurrentUserRadioHandle = [IntPtr]::Zero; AllUsersRadioHandle = [IntPtr]::Zero
    CurrentUserPreset = 'unknown'; AllUsersPreset = 'unknown'
    CurrentUserSelected = 'unknown'; AllUsersSelected = 'unknown'
  }
  if (-not $script:nativeWindowApiAvailable -or $MainWindowHandle -eq [IntPtr]::Zero) { return [pscustomobject]$result }
  try {
    $windows = @()
    $after = [IntPtr]::Zero
    for ($index = 0; $index -lt 16; $index++) {
      $child = [TUSWindowApi]::FindWindowEx($MainWindowHandle, $after, '#32770', $null)
      if ($child -eq [IntPtr]::Zero) { break }
      $after = $child
      $childProcessId = [uint32]0
      $threadId = [TUSWindowApi]::GetWindowThreadProcessId($child, [ref]$childProcessId)
      $parentStatus = if ([TUSWindowApi]::GetParent($child) -eq $MainWindowHandle) { 'match' } else { 'mismatch' }
      $processStatus = if ($threadId -eq 0) { 'unknown' } elseif ($childProcessId -eq $ProcessId) { 'match' } else { 'mismatch' }
      $className = [System.Text.StringBuilder]::new(128)
      $classStatus = 'unknown'
      if ([TUSWindowApi]::GetClassName($child, $className, $className.Capacity) -gt 0) {
        $classStatus = if ($className.ToString() -eq '#32770') { 'native-dialog' } else { 'other' }
      }
      $windows += [pscustomobject]@{
        Handle = $child; Parent = $parentStatus; Process = $processStatus
        Visible = if ([TUSWindowApi]::IsWindowVisible($child)) { 'visible' } else { 'hidden' }
        Class = $classStatus
      }
    }
    if ($windows.Count -ge 16) { $result.PageWindow = 'ambiguous'; return [pscustomobject]$result }
    $pages = @($windows | Where-Object {
      $_.Parent -eq 'match' -and $_.Process -eq 'match' -and $_.Visible -eq 'visible' -and $_.Class -eq 'native-dialog'
    })
    if ($pages.Count -gt 1) {
      $result.PageWindow = 'ambiguous'; $result.PageParent = 'match'; $result.PageProcess = 'match'
      $result.PageVisible = 'visible'; $result.PageClass = 'native-dialog'
      return [pscustomobject]$result
    }
    if ($pages.Count -eq 1) {
      $page = $pages[0]
      $result.Handle = $page.Handle; $result.PageWindow = 'present'; $result.PageParent = $page.Parent
      $result.PageProcess = $page.Process; $result.PageVisible = $page.Visible; $result.PageClass = $page.Class
    } elseif ($windows.Count -eq 0) {
      $result.PageWindow = 'missing'
      return [pscustomobject]$result
    } elseif ($windows.Count -eq 1) {
      $page = $windows[0]
      $result.PageWindow = 'present'; $result.PageParent = $page.Parent; $result.PageProcess = $page.Process
      $result.PageVisible = $page.Visible; $result.PageClass = $page.Class
      return [pscustomobject]$result
    } else {
      $result.PageWindow = 'ambiguous'
      return [pscustomobject]$result
    }

    $pageHandle = $result.Handle
    $result.DirectoryEdit = Get-NativeControlStatus -Window $pageHandle -ControlId 1019 -ExpectedClass 'Edit'
    $result.DirectoryBrowse = Get-NativeControlStatus -Window $pageHandle -ControlId 1001 -ExpectedClass 'Button'
    $result.DirectoryText = Get-NativeControlStatus -Window $pageHandle -ControlId 1006 -ExpectedClass 'Static'
    $result.InstallProgress = Get-NativeControlStatus -Window $pageHandle -ControlId 1004 -ExpectedClass 'msctls_progress32'
    $controls = @()
    $optionEnumerationComplete = $false
    $optionEnumerationFailed = $false
    $control = [TUSWindowApi]::GetWindow($pageHandle, 5)
    for ($index = 0; $index -lt 128; $index++) {
      if ($control -eq [IntPtr]::Zero) { $optionEnumerationComplete = $true; break }
      $className = [System.Text.StringBuilder]::new(128)
      if ([TUSWindowApi]::GetClassName($control, $className, $className.Capacity) -le 0) {
        $optionEnumerationFailed = $true
        break
      }
      if ($className.ToString() -eq 'Button') {
        $style = [TUSWindowApi]::GetWindowLong($control, -16)
        $captionLength = [TUSWindowApi]::GetWindowTextLength($control)
        if ($captionLength -lt 0 -or $captionLength -gt 256) {
          $optionEnumerationFailed = $true
          break
        }
        $caption = ''
        if ($captionLength -gt 0) {
          $captionBuffer = [System.Text.StringBuilder]::new(257)
          if ([TUSWindowApi]::GetWindowText($control, $captionBuffer, $captionBuffer.Capacity) -le 0) {
            $optionEnumerationFailed = $true
            break
          }
          $caption = $captionBuffer.ToString()
        }
        $controls += [pscustomobject]@{ Handle = $control; Style = $style; Caption = $caption }
      }
      $control = [TUSWindowApi]::GetWindow($control, 2)
    }
    if ($control -eq [IntPtr]::Zero) { $optionEnumerationComplete = $true }
    if ($optionEnumerationComplete -and -not $optionEnumerationFailed) {
      $radioControls = @($controls | Where-Object { ($_.Style -band 0x0f) -eq 9 })
      $result.OptionRadioCount = Get-SafeControlCount -Count $radioControls.Count
      if ($radioControls.Count -eq 2) {
        $result.OptionRadioStyle = 'match'
        $userSuffix = '(' + [Environment]::UserName + ')'
        $currentUserRadios = @($radioControls | Where-Object {
          $_.Caption.EndsWith($userSuffix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($currentUserRadios.Count -eq 1) {
          $otherRadio = @($radioControls | Where-Object { $_.Handle -ne $currentUserRadios[0].Handle })[0]
          if ($otherRadio.Caption.Length -gt 0 -and
              -not $otherRadio.Caption.EndsWith($userSuffix, [StringComparison]::OrdinalIgnoreCase)) {
            $result.CurrentUserPreset = 'match'
            # The pinned template has only two presets; the other labeled radio is the all-users option.
            $result.AllUsersPreset = 'match'
            $result.CurrentUserRadioHandle = $currentUserRadios[0].Handle
            $result.AllUsersRadioHandle = $otherRadio.Handle
            $result.CurrentUserSelected = Get-NativeRadioSelection -Handle $currentUserRadios[0].Handle -ProcessId $ProcessId -PageHandle $pageHandle
            $result.AllUsersSelected = Get-NativeRadioSelection -Handle $otherRadio.Handle -ProcessId $ProcessId -PageHandle $pageHandle
          } else {
            $result.CurrentUserPreset = 'mismatch'
            $result.AllUsersPreset = 'mismatch'
          }
        } else {
          $result.CurrentUserPreset = 'mismatch'
          $result.AllUsersPreset = 'mismatch'
        }
      } else {
        $result.OptionRadioStyle = 'mismatch'
        $result.CurrentUserPreset = 'mismatch'
        $result.AllUsersPreset = 'mismatch'
      }
      if ($result.OptionRadioCount -eq 'two' -and $result.OptionRadioStyle -eq 'match' -and
          $result.CurrentUserPreset -eq 'match' -and $result.AllUsersPreset -eq 'match') {
        $result.OptionPage = 'install-options'
      } else {
        $result.OptionPage = 'other'
      }
    }
    if ($result.OptionPage -eq 'install-options') {
      $next = Get-OptionNextControl -ProcessId $ProcessId -MainWindowHandle $MainWindowHandle
      $result.OptionNext = $next.Status
      $result.OptionNextHandle = $next.Handle
    }
    if ($result.DirectoryText -eq 'match' -and $result.DirectoryEdit -eq 'match' -and $result.DirectoryBrowse -eq 'match') {
      $result.NativePage = 'directory'
    } elseif ($result.DirectoryText -eq 'match' -and $result.InstallProgress -eq 'match' -and
        $result.DirectoryEdit -eq 'missing' -and $result.DirectoryBrowse -eq 'missing') {
      $result.NativePage = 'install-files'
    } elseif ($result.DirectoryEdit -ne 'unknown' -and $result.DirectoryBrowse -ne 'unknown' -and
        $result.DirectoryText -ne 'unknown' -and $result.InstallProgress -ne 'unknown') {
      $result.NativePage = 'other'
    }
  } catch {}
  return [pscustomobject]$result
}

function Get-Win32WindowSummary {
  param([int]$ProcessId, [IntPtr]$Handle)
  $result = [ordered]@{
    Foreground = 'unknown'; WindowClass = 'unknown'; NativeTitle = 'unknown'; NativePage = 'unknown'
    PageHandle = [IntPtr]::Zero; PageWindow = 'unknown'; PageParent = 'unknown'; PageProcess = 'unknown'
    PageVisible = 'unknown'; PageClass = 'unknown'
    DirectoryEdit = 'unknown'; DirectoryBrowse = 'unknown'; DirectoryText = 'unknown'; InstallProgress = 'unknown'
    OptionPage = 'unknown'; OptionRadioCount = 'unknown'; OptionRadioStyle = 'unknown'; OptionNext = 'unknown'
    OptionNextHandle = [IntPtr]::Zero; CurrentUserRadioHandle = [IntPtr]::Zero; AllUsersRadioHandle = [IntPtr]::Zero
    CurrentUserPreset = 'unknown'; AllUsersPreset = 'unknown'
    CurrentUserSelected = 'unknown'; AllUsersSelected = 'unknown'
    UiaProvider = 'unknown'; UiaDescendants = 'unknown'; Children = 'unknown'
    Buttons = 'unknown'; Static = 'unknown'; Session = 'unknown'
    Desktop = 'unknown'; Visible = 'unknown'
  }
  if (-not $script:nativeWindowApiAvailable -or $Handle -eq [IntPtr]::Zero) { return [pscustomobject]$result }
  try {
    $windowProcessId = [uint32]0
    $windowThreadId = [TUSWindowApi]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId)
    if ($windowThreadId -eq 0 -or $windowProcessId -ne $ProcessId) { return [pscustomobject]$result }

    $page = Get-NsisPageSummary -ProcessId $ProcessId -MainWindowHandle $Handle
    $result.PageHandle = $page.Handle; $result.PageWindow = $page.PageWindow
    $result.PageParent = $page.PageParent; $result.PageProcess = $page.PageProcess
    $result.PageVisible = $page.PageVisible; $result.PageClass = $page.PageClass
    $result.NativePage = $page.NativePage
    $result.DirectoryEdit = $page.DirectoryEdit; $result.DirectoryBrowse = $page.DirectoryBrowse
    $result.DirectoryText = $page.DirectoryText; $result.InstallProgress = $page.InstallProgress
    $result.OptionPage = $page.OptionPage; $result.OptionRadioCount = $page.OptionRadioCount
    $result.OptionRadioStyle = $page.OptionRadioStyle; $result.OptionNext = $page.OptionNext
    $result.OptionNextHandle = $page.OptionNextHandle
    $result.CurrentUserRadioHandle = $page.CurrentUserRadioHandle; $result.AllUsersRadioHandle = $page.AllUsersRadioHandle
    $result.CurrentUserPreset = $page.CurrentUserPreset; $result.AllUsersPreset = $page.AllUsersPreset
    $result.CurrentUserSelected = $page.CurrentUserSelected; $result.AllUsersSelected = $page.AllUsersSelected

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
    Foreground = 'unknown'; WindowClass = 'unknown'; NativeTitle = 'unknown'; NativePage = 'unknown'
    PageWindow = 'unknown'; PageParent = 'unknown'; PageProcess = 'unknown'; PageVisible = 'unknown'; PageClass = 'unknown'
    DirectoryEdit = 'unknown'; DirectoryBrowse = 'unknown'; DirectoryText = 'unknown'; InstallProgress = 'unknown'
    OptionPage = 'unknown'; OptionRadioCount = 'unknown'; OptionRadioStyle = 'unknown'; OptionNext = 'unknown'
    CurrentUserPreset = 'unknown'; AllUsersPreset = 'unknown'
    CurrentUserSelected = 'unknown'; AllUsersSelected = 'unknown'
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
    $progressCondition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ProgressBar)
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
          $summary.NativePage = $native.NativePage
          $summary.PageWindow = $native.PageWindow; $summary.PageParent = $native.PageParent
          $summary.PageProcess = $native.PageProcess; $summary.PageVisible = $native.PageVisible
          $summary.PageClass = $native.PageClass
          $summary.DirectoryEdit = $native.DirectoryEdit
          $summary.DirectoryBrowse = $native.DirectoryBrowse
          $summary.DirectoryText = $native.DirectoryText
          $summary.InstallProgress = $native.InstallProgress
          $summary.OptionPage = $native.OptionPage; $summary.OptionRadioCount = $native.OptionRadioCount
          $summary.OptionRadioStyle = $native.OptionRadioStyle; $summary.OptionNext = $native.OptionNext
          $summary.CurrentUserPreset = $native.CurrentUserPreset; $summary.AllUsersPreset = $native.AllUsersPreset
          $summary.CurrentUserSelected = $native.CurrentUserSelected; $summary.AllUsersSelected = $native.AllUsersSelected
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
        $progressBars = @($candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $progressCondition))
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
        $installFilesPage = $progressBars.Count -eq 1
        if ($installModePage -or $directoryPage -or $finishPage -or $installFilesPage) { $knownPages += $handle }
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
    [ValidateSet('directory', 'install-files', 'other', 'unknown')][string]$NativePage,
    [ValidateSet('present', 'missing', 'ambiguous', 'unknown')][string]$PageWindow,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$PageParent,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$PageProcess,
    [ValidateSet('visible', 'hidden', 'unknown')][string]$PageVisible,
    [ValidateSet('native-dialog', 'other', 'unknown')][string]$PageClass,
    [ValidateSet('install-options', 'other', 'unknown')][string]$OptionPage,
    [ValidateSet('none', 'one', 'two', 'many', 'unknown')][string]$OptionRadioCount,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$OptionRadioStyle,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$CurrentUserPreset,
    [ValidateSet('match', 'mismatch', 'unknown')][string]$AllUsersPreset,
    [ValidateSet('selected', 'unselected', 'unknown')][string]$CurrentUserSelected,
    [ValidateSet('selected', 'unselected', 'unknown')][string]$AllUsersSelected,
    [ValidateSet('match', 'missing', 'disabled', 'hidden', 'wrong-class', 'owner-mismatch', 'unknown')][string]$OptionNext,
    [ValidateSet('install-mode', 'directory', 'install-files', 'finish', 'other', 'unknown')][string]$UiaPage,
    [ValidateSet('match', 'missing', 'wrong-class', 'unknown')][string]$DirectoryEdit,
    [ValidateSet('match', 'missing', 'wrong-class', 'unknown')][string]$DirectoryBrowse,
    [ValidateSet('match', 'missing', 'wrong-class', 'unknown')][string]$DirectoryText,
    [ValidateSet('match', 'missing', 'wrong-class', 'unknown')][string]$InstallProgress,
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
  [Console]::Out.WriteLine("TUS_NSIS_WIZARD snapshot stage=$Stage process=path-match window=pid-match page-window=$PageWindow page-parent=$PageParent page-process=$PageProcess page-visible=$PageVisible page-class=$PageClass option-page=$OptionPage option-radio-count=$OptionRadioCount option-radio-style=$OptionRadioStyle current-user-preset=$CurrentUserPreset all-users-preset=$AllUsersPreset current-user-selected=$CurrentUserSelected all-users-selected=$AllUsersSelected option-next=$OptionNext title=$Title mode=$Mode current-user=$CurrentUser radios=$Radios edits=$Edits next=$Next install=$Install finish=$Finish destination=$Destination native-page=$NativePage uia-page=$UiaPage directory-edit=$DirectoryEdit directory-browse=$DirectoryBrowse directory-text=$DirectoryText install-progress=$InstallProgress uia-top-level=$UiaTopLevel main-window=$MainWindow wizard-window=$WizardWindow foreground=$Foreground window-class=$WindowClass native-title=$NativeTitle uia-provider=$UiaProvider uia-descendants=$UiaDescendants win32-children=$Win32Children win32-buttons=$Win32Buttons win32-static=$Win32Static session=$Session desktop=$Desktop visible=$Visible pid=$ProcessId")
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
$progressCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ProgressBar)
$trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$normalizedExpectedDir = [System.IO.Path]::GetFullPath($expectedInstallDir).TrimEnd($trimCharacters)
$snapshot = [ordered]@{
  Stage = 'entry'; Title = 'unknown'; Mode = 'unknown'; CurrentUser = 'unknown'
  Radios = 'none'; Edits = 'none'; Next = 'missing'; Install = 'missing'
  Finish = 'missing'; Destination = 'unknown'; UiPage = 'unknown'
  OptionPage = 'unknown'; OptionRadioCount = 'unknown'; OptionRadioStyle = 'unknown'
  CurrentUserPreset = 'unknown'; AllUsersPreset = 'unknown'
  CurrentUserSelected = 'unknown'; AllUsersSelected = 'unknown'
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
  $nativeWindow = Get-Win32WindowSummary -ProcessId $script:installerProcessId -Handle $handle
  $pageWindow = $null
  if ($nativeWindow.PageWindow -eq 'present' -and $nativeWindow.PageParent -eq 'match' -and
      $nativeWindow.PageProcess -eq 'match' -and $nativeWindow.PageVisible -eq 'visible' -and
      $nativeWindow.PageClass -eq 'native-dialog' -and $nativeWindow.PageHandle -ne [IntPtr]::Zero) {
    try {
      $pageCandidate = [System.Windows.Automation.AutomationElement]::FromHandle($nativeWindow.PageHandle)
      if ($null -ne $pageCandidate -and $pageCandidate.Current.ProcessId -eq $script:installerProcessId -and
          [IntPtr]$pageCandidate.Current.NativeWindowHandle -eq $nativeWindow.PageHandle -and
          -not $pageCandidate.Current.IsOffscreen) { $pageWindow = $pageCandidate }
    } catch {}
  }
  $buttons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition))
  $edits = @(); $radios = @(); $progressBars = @()
  if ($null -ne $pageWindow) {
    $edits = @($pageWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition))
    $radios = @($pageWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $radioCondition))
    $progressBars = @($pageWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $progressCondition))
  }
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
  $uiaPageStatus = 'other'
  if ($radios.Count -gt 0) {
    if ($modeStatus -eq 'present' -and $currentUserRadios.Count -eq 1 -and $next.Count -eq 1) { $uiaPageStatus = 'install-mode' }
    else { $uiaPageStatus = 'unknown' }
  } elseif ($edits.Count -gt 0) {
    if ($edits.Count -eq 1 -and (($next.Count -eq 1 -and $install.Count -eq 0) -or ($install.Count -eq 1 -and $next.Count -eq 0))) { $uiaPageStatus = 'directory' }
    else { $uiaPageStatus = 'unknown' }
  } elseif ($finish.Count -gt 0) {
    if ($finish.Count -eq 1) { $uiaPageStatus = 'finish' } else { $uiaPageStatus = 'unknown' }
  } elseif ($progressBars.Count -gt 0) {
    if ($progressBars.Count -eq 1) { $uiaPageStatus = 'install-files' } else { $uiaPageStatus = 'unknown' }
  }
  $snapshot = [ordered]@{
    Stage = $stage; Title = $titleStatus; Mode = $modeStatus; CurrentUser = $currentUserStatus; UiPage = $uiaPageStatus
    OptionPage = $nativeWindow.OptionPage; OptionRadioCount = $nativeWindow.OptionRadioCount
    OptionRadioStyle = $nativeWindow.OptionRadioStyle
    CurrentUserPreset = $nativeWindow.CurrentUserPreset; AllUsersPreset = $nativeWindow.AllUsersPreset
    CurrentUserSelected = $nativeWindow.CurrentUserSelected; AllUsersSelected = $nativeWindow.AllUsersSelected
    Radios = $radioCountStatus
    Edits = $editCountStatus
    Next = $nextStatus; Install = $installStatus; Finish = $finishStatus
    Destination = $destinationStatus
  }

  if ($null -eq $pageWindow) { Start-Sleep -Milliseconds 100; continue }

  if ($stage -eq 'entry') {
    if ($modeStatus -eq 'present' -and $uiaPageStatus -eq 'install-mode') {
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
    if ($nativeWindow.OptionPage -eq 'install-options') {
      $stage = 'install-mode'; $snapshot.Stage = $stage
      if ($modeStatus -ne 'absent' -or $uiaPageStatus -ne 'other' -or $nativeWindow.NativePage -ne 'other' -or
          $nativeWindow.PageWindow -ne 'present' -or $nativeWindow.PageParent -ne 'match' -or
          $nativeWindow.PageProcess -ne 'match' -or $nativeWindow.PageVisible -ne 'visible' -or
          $nativeWindow.PageClass -ne 'native-dialog' -or $nativeWindow.OptionRadioCount -ne 'two' -or
          $nativeWindow.OptionRadioStyle -ne 'match' -or $nativeWindow.CurrentUserPreset -ne 'match' -or
          $nativeWindow.AllUsersPreset -ne 'match' -or $nativeWindow.CurrentUserSelected -ne 'selected' -or
          $nativeWindow.AllUsersSelected -ne 'unselected') {
        Write-WizardEvent -Name 'install-mode-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      $currentUserSelection = Get-NativeRadioSelection -Handle $nativeWindow.CurrentUserRadioHandle -ProcessId $script:installerProcessId -PageHandle $nativeWindow.PageHandle
      $allUsersSelection = Get-NativeRadioSelection -Handle $nativeWindow.AllUsersRadioHandle -ProcessId $script:installerProcessId -PageHandle $nativeWindow.PageHandle
      if ($currentUserSelection -ne 'selected' -or $allUsersSelection -ne 'unselected') {
        Write-WizardEvent -Name 'install-mode-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      $nextControl = Get-OptionNextControl -ProcessId $script:installerProcessId -MainWindowHandle $script:mainWindowHandle
      if ($nativeWindow.OptionNext -ne 'match' -or $nextControl.Status -ne 'match' -or
          $nextControl.Handle -eq [IntPtr]::Zero -or $nextControl.Handle -ne $nativeWindow.OptionNextHandle) {
        Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      $clickResult = [IntPtr]::Zero
      $sent = [TUSWindowApi]::SendMessageTimeout($nextControl.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 500, [ref]$clickResult)
      if ($sent -eq [IntPtr]::Zero) {
        Write-WizardEvent -Name 'next-unavailable' -ProcessId $script:installerProcessId
        exit 2
      }
      $snapshot.CurrentUser = 'selected'
      Write-WizardEvent -Name 'install-mode-verified' -ProcessId $script:installerProcessId
      $stage = 'directory'
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($modeStatus -eq 'unknown') { Start-Sleep -Milliseconds 100; continue }
    if ($edits.Count -eq 1 -and $uiaPageStatus -eq 'directory' -and $nativeWindow.NativePage -eq 'directory') {
      $stage = 'directory'; $snapshot.Stage = $stage
    } elseif ($edits.Count -gt 1) {
      Write-WizardEvent -Name 'destination-unavailable' -ProcessId $script:installerProcessId; exit 2
    } else {
      Start-Sleep -Milliseconds 100
      continue
    }
  }

  if ($stage -eq 'directory') {
    if ($uiaPageStatus -ne 'directory' -or $nativeWindow.NativePage -ne 'directory') {
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
    if ($install.Count -eq 1 -and $destinationVerified -and $uiaPageStatus -eq 'directory' -and
        $nativeWindow.NativePage -eq 'directory') {
      $install[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-WizardEvent -Name 'install-started' -ProcessId $script:installerProcessId
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($finish.Count -eq 1 -and $uiaPageStatus -eq 'finish') {
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
  Write-WizardSnapshot -Stage $snapshot.Stage -Title $snapshot.Title -Mode $snapshot.Mode -CurrentUser $snapshot.CurrentUser -Radios $snapshot.Radios -Edits $snapshot.Edits -Next $snapshot.Next -Install $snapshot.Install -Finish $snapshot.Finish -Destination $snapshot.Destination -NativePage $windowSummary.NativePage -PageWindow $windowSummary.PageWindow -PageParent $windowSummary.PageParent -PageProcess $windowSummary.PageProcess -PageVisible $windowSummary.PageVisible -PageClass $windowSummary.PageClass -OptionPage $windowSummary.OptionPage -OptionRadioCount $windowSummary.OptionRadioCount -OptionRadioStyle $windowSummary.OptionRadioStyle -CurrentUserPreset $windowSummary.CurrentUserPreset -AllUsersPreset $windowSummary.AllUsersPreset -CurrentUserSelected $windowSummary.CurrentUserSelected -AllUsersSelected $windowSummary.AllUsersSelected -OptionNext $windowSummary.OptionNext -UiaPage $snapshot.UiPage -DirectoryEdit $windowSummary.DirectoryEdit -DirectoryBrowse $windowSummary.DirectoryBrowse -DirectoryText $windowSummary.DirectoryText -InstallProgress $windowSummary.InstallProgress -UiaTopLevel $windowSummary.UiaTopLevel -MainWindow $windowSummary.MainWindow -WizardWindow $windowSummary.WizardWindow -Foreground $windowSummary.Foreground -WindowClass $windowSummary.WindowClass -NativeTitle $windowSummary.NativeTitle -UiaProvider $windowSummary.UiaProvider -UiaDescendants $windowSummary.UiaDescendants -Win32Children $windowSummary.Win32Children -Win32Buttons $windowSummary.Win32Buttons -Win32Static $windowSummary.Win32Static -Session $windowSummary.Session -Desktop $windowSummary.Desktop -Visible $windowSummary.Visible -ProcessId $script:installerProcessId
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
