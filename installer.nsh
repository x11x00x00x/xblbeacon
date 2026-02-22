; Custom NSIS installer script for XBL Beacon

; Disable integrity check for uninstaller (fixes "integrity check failed" error)
!define MULTIUSER_EXECUTIONLEVEL "User"

; Close running application before installation
!macro customInstall
  ; Close any running instances of XBL Beacon before installation
  DetailPrint "Checking for running XBL Beacon instances..."
  
  ; Forcefully kill the process - this will fail silently if the process doesn't exist
  ; Error codes: 0 = success, 128 = process not found (which is fine for us)
  DetailPrint "Closing XBL Beacon if running..."
  ExecWait 'taskkill /F /IM "XBL Beacon.exe" /T' $R3
  
  ; Also try to kill by window title (catches any Electron processes)
  ExecWait 'taskkill /F /FI "WINDOWTITLE eq XBL Beacon*" /T' $R4
  
  ; Wait for processes to fully terminate and files to be released
  ; This is critical - Windows needs time to release file handles
  Sleep 2000
  
  ; Double-check and kill again if needed (sometimes processes take a moment to die)
  ExecWait 'taskkill /F /IM "XBL Beacon.exe" /T' $R5
  Sleep 1000
  ; Check if already installed by looking for uninstaller
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" checkFiles
  
  ; Uninstaller found - try to run it silently first
  ; Use /S for silent mode and _?= to prevent integrity check issues
  ExecWait '"$R0" /S _?=$INSTDIR' $R1
  
  ; Check if uninstaller succeeded (0 = success)
  IntCmp $R1 0 checkFiles
  
  ; Uninstaller failed or returned error, try manual removal
  Goto manualRemove
  
  checkFiles:
    ; Check if application directory still exists (uninstaller might have failed)
    IfFileExists "$INSTDIR\XBL Beacon.exe" manualRemove
    IfFileExists "$INSTDIR\resources\app.asar" manualRemove
    Goto cleanupRegistry
  
  manualRemove:
    ; Forcefully remove application files
    ; Kill any running processes first (ignore errors if process doesn't exist)
    DetailPrint "Closing any running XBL Beacon processes..."
    ExecWait 'taskkill /F /IM "XBL Beacon.exe" /T' $R2
    ; Don't check return code - process might not be running
    
    ; Also try to close by window title
    ExecWait 'taskkill /F /FI "WINDOWTITLE eq XBL Beacon*" /T' $R5
    
    ; Wait a moment for processes to close and files to be released
    Sleep 2000
    
    ; Try to remove application directory
    ; Use /REBOOTOK in case files are locked
    RMDir /r /REBOOTOK "$INSTDIR"
    
    ; Also try removing common alternative locations
    RMDir /r /REBOOTOK "$LOCALAPPDATA\Programs\xblbeacon"
    
    ; Wait for file system
    Sleep 500
  
  cleanupRegistry:
    ; Remove application data
    RMDir /r "$APPDATA\xblbeacon"
    
    ; Remove registry entries
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    DeleteRegKey /ifempty HKCU "Software\XBLBeacon"
    
    ; Remove startup entry
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "XBL Beacon"
    
    ; Wait a moment for registry to update
    Sleep 300
  
  done:
!macroend

; Custom uninstall actions
!macro customUnInstall
  ; Delete the application data
  RMDir /r "$APPDATA\xblbeacon"
  
  ; Remove startup entry if it exists
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "XBL Beacon"
  
  ; Remove any remaining registry entries
  DeleteRegKey /ifempty HKCU "Software\XBLBeacon"
!macroend

; Fix uninstaller integrity check
!macro customUnInit
  ; This helps bypass integrity check issues
  SetOutPath "$TEMP"
!macroend

