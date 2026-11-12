param(
  [Parameter(Mandatory=$true)][ValidateSet('keep-open','quit-anyway','file-exit')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueCondition = [System.Windows.Automation.Condition]::TrueCondition
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
)
switch ($Action) {
  'keep-open'
  'quit-anyway' {
    $buttonName = if ($Action -eq 'keep-open') { 'Keep the game open' } else { 'Quit anyway' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $dialog = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $topWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $trueCondition)
      foreach ($candidate in $topWindows) {
        try {
          if ($candidate.Current.ProcessId -ne $ProcessId) { continue }
          $elements = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueCondition)
          $names = @($candidate.Current.Name)
          foreach ($element in $elements) { try { $names += $element.Current.Name } catch {} }
          if ($names -contains 'The current Codex activity is unknown.' -and
              $names -contains 'Keep the game open' -and $names -contains 'Quit anyway') {
            $dialog = $candidate
            break
          }
        } catch {}
      }
      if ($dialog) { break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $dialog) { throw 'The expected unknown-Codex native quit confirmation was not found.' }
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
    )
    $button = $null
    foreach ($candidate in $buttons) { if ($candidate.Current.Name -eq $buttonName) { $button = $candidate; break } }
    if (-not $button) { throw "Expected native quit button '$buttonName' was not found." }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Clicked native '$buttonName' button."
    break
  }
  'file-exit' {
    $fileName = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'File'
    )
    $menuType = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::MenuItem
    )
    $fileCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.Condition[]]@($processCondition, $fileName, $menuType)
    )
    $file = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)
    if (-not $file) { throw 'The packaged TUS File menu was not found.' }
    try { $file.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    catch { $file.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    $exitName = $null
    $visibleNames = @()
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and -not $exitName) {
      $items = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
          $processCondition,
          [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::MenuItem
          )
        ))
      )
      foreach ($item in $items) {
        $visibleNames += $item.Current.Name
        if ($item.Current.Name -match '^(Exit|Quit)$') { $exitName = $item.Current.Name; $exitItem = $item; break }
      }
      if (-not $exitName) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $exitName) { throw "File menu did not expose Exit or Quit; menu items: $($visibleNames -join ', ')" }
    $exitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Write-Output "Invoked File -> $exitName."
    break
  }
}
