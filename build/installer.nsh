; Included by electron-builder (nsis.include). On a real uninstall (not an update), SexyVal undoes what
; Stretch and Boost changed: native display mode, Valorant's original GameUserSettings.ini, every Boost
; tweak from its journal, and the elevated helper task.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --sexyval-uninstall'
  ${endIf}
!macroend
