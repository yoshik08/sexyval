; Included by electron-builder (nsis.include). On a real uninstall (not an update), SexyVal undoes what
; Stretch and Boost changed: native display mode, Valorant's original GameUserSettings.ini, every Boost
; tweak from its journal, and the elevated helper task.
; Then it asks whether to delete your data too. The default (and silent uninstalls) keep it: settings,
; history and the .sxyval vault stay, and a later install restores from them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --sexyval-uninstall'
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your SexyVal data?$\r$\n$\r$\nThis removes your settings, saved accounts, store history, purchases and the SexyVal vault (backups):$\r$\n  $APPDATA\SexyVal$\r$\n  $LOCALAPPDATA\SexyVal$\r$\n$\r$\nChoose No to keep them; reinstalling SexyVal brings everything back." /SD IDNO IDNO keepData
      RMDir /r "$APPDATA\SexyVal"
      RMDir /r "$LOCALAPPDATA\SexyVal"
    keepData:
  ${endIf}
!macroend
