; Custom NSIS include — password-gates the installer. The expected password
; is baked in at build time from the INSTALLER_PASSWORD env var. Without a
; match, the installer aborts before copying any files.

!include "LogicLib.nsh"

!ifndef INSTALLER_PASSWORD
  !define INSTALLER_PASSWORD "changeme"
!endif

Var /GLOBAL INSTALLER_PW_ATTEMPT

!macro customInit
  StrCpy $INSTALLER_PW_ATTEMPT ""
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 10u 10u 280u 24u "This installer is restricted. Enter the installer password to continue."
  Pop $1

  ${NSD_CreatePassword} 10u 44u 280u 14u ""
  Pop $2

  ${NSD_CreateLabel} 10u 62u 280u 10u "Contact your Super Admin if you do not have it."
  Pop $3

  nsDialogs::Show
  ${NSD_GetText} $2 $INSTALLER_PW_ATTEMPT

  ${If} $INSTALLER_PW_ATTEMPT != "${INSTALLER_PASSWORD}"
    MessageBox MB_ICONSTOP|MB_OK "Wrong installer password. Installation cancelled."
    Abort
  ${EndIf}
!macroend
