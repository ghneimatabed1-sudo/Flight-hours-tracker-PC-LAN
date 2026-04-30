; Custom NSIS for password-gated installation.
;
; History:
;  v1: nsDialogs in customInit (.onInit) — silently aborted because the
;      installer's main window doesn't exist that early.
;  v2: moved to a custom Page via customPageAfterChangeDir, but referenced
;      MUI_HEADER_TEXT which isn't defined when this file is first parsed.
;  v3: include nsDialogs.nsh + LogicLib.nsh at top, drop MUI_HEADER_TEXT.
;  v4: wrap everything in !ifndef BUILD_UNINSTALLER. NSIS compiles the
;      uninstaller in a second pass with BUILD_UNINSTALLER defined; in that
;      pass customPageAfterChangeDir is skipped, so the Functions appear
;      unreferenced and "warning treated as error" kills the build.

!define INSTALL_PASSWORD "$%INSTALL_PASSWORD%"
!if "${INSTALL_PASSWORD}" == ""
  !error "INSTALL_PASSWORD must not be empty."
!endif

!ifndef BUILD_UNINSTALLER

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  Var RjafPwdInput
  Var RjafPwdEntered

  !macro customPageAfterChangeDir
    Page custom RjafPwdPageShow RjafPwdPageLeave
  !macroend

  Function RjafPwdPageShow
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 16u "RJAF Squadron Ops — Installation Password"
    Pop $1

    ${NSD_CreateLabel} 0 22u 100% 30u "Enter the master installation password issued by the RJAF Super Admin to continue."
    Pop $2

    ${NSD_CreatePassword} 0 60u 100% 14u ""
    Pop $RjafPwdInput
    ${NSD_SetFocus} $RjafPwdInput

    nsDialogs::Show
  FunctionEnd

  Function RjafPwdPageLeave
    ${NSD_GetText} $RjafPwdInput $RjafPwdEntered
    ${If} $RjafPwdEntered != "${INSTALL_PASSWORD}"
      MessageBox MB_ICONSTOP|MB_OK "Incorrect installation password. Please try again, or close the installer to cancel."
      Abort
    ${EndIf}
  FunctionEnd

!endif
