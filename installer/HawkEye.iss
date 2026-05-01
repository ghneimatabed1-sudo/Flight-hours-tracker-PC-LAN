; HawkEye.iss
;
; Hawk Eye one-click Windows installer.
;
; Replaces the "open PowerShell as Administrator and run a script" flow
; with a double-click installer. The operator picks a role on screen 2
; (Squadron Hub, Wing Commander, Base Commander, or Viewer laptop),
; answers a small per-role form, and the installer invokes the
; matching PowerShell script silently. The original PowerShell scripts
; in scripts\lan-host\ remain available as the advanced /
; troubleshooting path.
;
; Build:
;   .\build.ps1     (orchestrates prebuilds + downloads + iscc)
; or directly:
;   iscc HawkEye.iss
;
; Inputs the build script must stage before iscc runs:
;   build-cache\repo\          — workspace minus node_modules/.git, with prebuilt
;                                 artifacts/api-server/dist and
;                                 artifacts/pilot-dashboard/dist already populated
;   build-cache\node\          — Node.js LTS portable (extracted .zip from nodejs.org)
;   build-cache\pnpm\pnpm.exe  — pnpm portable single-file binary
;
; Build/iscc verification status:
;   This script targets Inno Setup 6.2+. It has been hand-validated
;   against the documented Pascal Script API (CreateInputOptionPage,
;   CreateInputQueryPage, CreateCustomPage, [Run] Check:/Parameters:
;   with {code:...} helpers, CurStepChanged hooks). It cannot be
;   compiled on Replit (Inno Setup is Windows-only); build.ps1 is the
;   canonical entry point on a Windows builder.
;
; Secret handling:
;   Passwords entered on the wizard are written to a temp file under
;   {tmp}\hawkeye-creds.txt and passed to the shim via -CredentialFile
;   only — never on the command line. The shim wipes the file the
;   moment it has read it, and Setup wipes {tmp} on exit. We use the
;   PrepareToInstall hook to write the file so it exists before any
;   [Run] entry executes.

#define MyAppName        "Hawk Eye"
#define MyAppVersion     "1.0.0"
#define MyAppPublisher   "Royal Jordanian Air Force"
#define MyAppURL         "https://example.invalid/hawk-eye"
#define MyAppId          "{6E4F4D0A-2A2C-4F8B-8B6A-2C8B4F1A9A0E}"

[Setup]
AppId={{#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\HawkEye
DefaultGroupName=Hawk Eye
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=HawkEye-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
UninstallDisplayName={#MyAppName} {#MyAppVersion}
SetupLogging=yes
ShowLanguageDialog=no
DirExistsWarning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The repo (everything the lan-host PowerShell scripts already use).
; build.ps1 stages this directory with node_modules + prebuilt artifact dist
; folders included so the installer is fully offline / no-network.
Source: "build-cache\repo\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

; Bundled portable Node.js LTS (so the target PC does not need a
; separate Node install). build.ps1 unzips node-vXX-win-x64.zip into
; build-cache\node\.
Source: "build-cache\node\*"; DestDir: "{app}\.runtime\node"; Flags: recursesubdirs createallsubdirs ignoreversion

; Bundled portable pnpm (single-file Windows binary).
Source: "build-cache\pnpm\pnpm.exe"; DestDir: "{app}\.runtime\pnpm"; Flags: ignoreversion

; Bundled portable Bonjour (dns-sd.exe + the Apple mDNS responder
; DLLs it depends on). Lets every Hawk Eye PC announce itself on
; `_hawkeye._tcp` for magic LAN auto-discovery without forcing the
; operator to install Bonjour Print Services first.
;
; Resolution order in register-mdns.ps1:
;   1. -DnsSdPath param
;   2. PATH (Bonjour Print Services adds itself there)
;   3. C:\Program Files\Bonjour\dns-sd.exe
;   4. C:\Program Files (x86)\Bonjour\dns-sd.exe
;   5. {app}\bonjour-portable\dns-sd.exe   ← this bundle
;
; NOTE for builders: place the redistributable Bonjour binaries in
; `installer/bonjour-portable/` before running build.ps1. See
; `installer/bonjour-portable/README.md` for the file list and the
; license obligations attached to redistributing them. The
; `skipifsourcedoesntexist` flag keeps the installer buildable on
; dev boxes that haven't staged the binaries yet (the Hawk Eye PCs
; will simply not see auto-discovery without them — the operator
; can still pair manually via setup-aggregator.ps1).
Source: "..\installer\bonjour-portable\*"; DestDir: "{app}\bonjour-portable"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; Shim scripts: thin wrappers that translate Inno Setup-style params
; into the form the existing first-time-setup.ps1 etc expect.
Source: "script-shims\*.ps1"; DestDir: "{app}\installer\script-shims"; Flags: ignoreversion recursesubdirs

; discover-hubs.ps1 is also embedded with the `dontcopy` flag so the
; wizard's viewer page can extract it into {tmp} via
; ExtractTemporaryFile() BEFORE [Files] runs (the operator needs to
; click "Discover hubs" while still on the wizard pages, which is
; before the rest of the repo has been laid down on disk).
Source: "script-shims\discover-hubs.ps1"; Flags: dontcopy

[Icons]
; Hub / aggregator: open the dashboard via the dashboard scheduled task URL.
; (We can't predict the port until install time, so the shortcut runs
; a tiny launcher .cmd that the shim writes into {app}.)
Name: "{group}\Hawk Eye Dashboard"; Filename: "{app}\installer\open-dashboard.cmd"; \
  WorkingDir: "{app}"; Comment: "Open the Hawk Eye dashboard in the default browser"; \
  Check: IsRoleHubOrAggregator
Name: "{commondesktop}\Hawk Eye Dashboard"; Filename: "{app}\installer\open-dashboard.cmd"; \
  WorkingDir: "{app}"; Check: IsRoleHubOrAggregator

; Viewer: launch-viewer.ps1 already handles the kiosk-style window.
Name: "{group}\Hawk Eye Viewer"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\lan-host\launch-viewer.ps1"""; \
  WorkingDir: "{app}"; Check: IsRoleViewer
Name: "{commondesktop}\Hawk Eye Viewer"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\lan-host\launch-viewer.ps1"""; \
  WorkingDir: "{app}"; Check: IsRoleViewer

[Run]
; Hub install — runs first-time-setup.ps1. Passwords are NOT on this
; command line; they live in {code:GetCredentialFile} which the shim
; reads then deletes. -SquadronName / -AdminUsername are not secret.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\installer\script-shims\install-hub.ps1"" -RepoRoot ""{app}"" -SquadronName ""{code:GetHubSquadronName}"" -AdminUsername ""{code:GetHubAdminUsername}"" -CredentialFile ""{code:GetCredentialFile}"" {code:GetHubMdnsFlag} -LogFile ""{app}\install-log.txt"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up Squadron Hub (this can take a few minutes)..."; \
  Flags: waituntilterminated; \
  Check: IsRoleHub

; Wing aggregator install. Same secret-handling rules.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\installer\script-shims\install-aggregator.ps1"" -RepoRoot ""{app}"" -Role wing -AggregatorName ""{code:GetAggHostname}"" -AdminUsername ""{code:GetAggAdminUsername}"" -CredentialFile ""{code:GetCredentialFile}"" -LogFile ""{app}\install-log.txt"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up Wing Commander PC (this can take a few minutes)..."; \
  Flags: waituntilterminated; \
  Check: IsRoleWing

; Base aggregator install.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\installer\script-shims\install-aggregator.ps1"" -RepoRoot ""{app}"" -Role base -AggregatorName ""{code:GetAggHostname}"" -AdminUsername ""{code:GetAggAdminUsername}"" -CredentialFile ""{code:GetCredentialFile}"" -LogFile ""{app}\install-log.txt"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up Base Commander PC (this can take a few minutes)..."; \
  Flags: waituntilterminated; \
  Check: IsRoleBase

; Viewer install (no passwords involved).
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\installer\script-shims\install-viewer.ps1"" -RepoRoot ""{app}"" -HubAddress ""{code:GetViewerHubAddress}"" -HubPort ""{code:GetViewerHubPort}"" -LogFile ""{app}\install-log.txt"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Configuring viewer..."; \
  Flags: waituntilterminated; \
  Check: IsRoleViewer

[UninstallRun]
; Run a single shim that:
;   - stops the api-server / dashboard scheduled tasks
;   - confirms with the operator before dropping the database
;   - always preserves a final .dump in %USERPROFILE%\Documents\HawkEye-Backup\
; The shim never silently deletes data.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\installer\script-shims\uninstall-prep.ps1"" -RepoRoot ""{app}"""; \
  RunOnceId: "HawkEyeUninstallPrep"; \
  Flags: waituntilterminated

[Code]
const
  CRLF = #13#10;
  ERR_COLOR = $000000C0; // BGR red

var
  RolePage:        TInputOptionWizardPage;
  HubPage:         TInputQueryWizardPage;
  HubMdnsPage:     TInputOptionWizardPage;
  AggregatorPage:  TInputQueryWizardPage;
  ViewerPage:      TInputQueryWizardPage;

  // 0 = Squadron Hub, 1 = Wing, 2 = Base, 3 = Viewer
  SelectedRole: Integer;

  // Inline validation labels (one per page) — replace MsgBox prompts.
  HubErrLabel:        TNewStaticText;
  AggregatorErrLabel: TNewStaticText;
  ViewerErrLabel:     TNewStaticText;

  // Viewer page extras: discovery UI.
  ViewerDiscoverBtn:  TNewButton;
  ViewerStatusLabel:  TNewStaticText;
  ViewerHubsListBox:  TNewListBox;
  // Parallel array: index in the listbox -> hostname / port chosen.
  DiscoveredHosts:    array of String;
  DiscoveredPorts:    array of String;

  // Captured from install-log.txt after a successful Hub install.
  CapturedPeerToken: String;

  // Custom widgets we add to the standard FinishedPage when the
  // installer ends (Hub install only).
  TokenPanel:    TPanel;
  TokenLabel:    TNewStaticText;
  TokenValueBox: TNewEdit;
  CopyButton:    TNewButton;

// ── Role helpers ────────────────────────────────────────────────────
function IsRoleHub:               Boolean; begin Result := SelectedRole = 0; end;
function IsRoleWing:              Boolean; begin Result := SelectedRole = 1; end;
function IsRoleBase:              Boolean; begin Result := SelectedRole = 2; end;
function IsRoleAggregator:        Boolean; begin Result := (SelectedRole = 1) or (SelectedRole = 2); end;
function IsRoleViewer:            Boolean; begin Result := SelectedRole = 3; end;
function IsRoleHubOrAggregator:   Boolean; begin Result := SelectedRole <= 2; end;

// ── {code:...} helpers used in [Run] Parameters: ─────────────────────
function GetHubSquadronName(Param: String): String;     begin Result := Trim(HubPage.Values[0]); end;
function GetHubAdminUsername(Param: String): String;    begin Result := Trim(HubPage.Values[2]); end;
function GetHubMdnsFlag(Param: String): String;
begin
  if HubMdnsPage.Values[0] then Result := '-EnableMdns' else Result := '';
end;

function GetAggHostname(Param: String): String;          begin Result := Trim(AggregatorPage.Values[0]); end;
function GetAggAdminUsername(Param: String): String;    begin Result := Trim(AggregatorPage.Values[2]); end;

function GetViewerHubAddress(Param: String): String;    begin Result := Trim(ViewerPage.Values[0]); end;
function GetViewerHubPort(Param: String): String;
begin
  Result := Trim(ViewerPage.Values[1]);
  if Result = '' then Result := '3847';
end;

// Path of the temp credential file. Same value on every call so the
// shims can find it. Lives under {tmp} which Setup wipes at exit.
function GetCredentialFile(Param: String): String;
begin
  Result := ExpandConstant('{tmp}\hawkeye-creds.txt');
end;

// ── Validation helpers ──────────────────────────────────────────────
function IsHostnameLikeChar(c: Char): Boolean;
begin
  Result := ((c >= 'A') and (c <= 'Z'))
         or ((c >= 'a') and (c <= 'z'))
         or ((c >= '0') and (c <= '9'))
         or (c = '-') or (c = '.') or (c = '_');
end;

// Shared rule: 1-15 chars, [A-Za-z0-9-], no leading/trailing hyphen,
// not all digits. Used for both squadron name and aggregator hostname.
function ValidateLanHostName(Value: String): Boolean;
var
  i: Integer;
  ch: Char;
  AllDigits: Boolean;
begin
  Result := False;
  Value := Trim(Value);
  if (Length(Value) < 1) or (Length(Value) > 15) then Exit;
  if (Value[1] = '-') or (Value[Length(Value)] = '-') then Exit;
  AllDigits := True;
  for i := 1 to Length(Value) do begin
    ch := Value[i];
    if not (((ch >= 'A') and (ch <= 'Z')) or
            ((ch >= 'a') and (ch <= 'z')) or
            ((ch >= '0') and (ch <= '9')) or
            (ch = '-')) then Exit;
    if not ((ch >= '0') and (ch <= '9')) then AllDigits := False;
  end;
  if AllDigits then Exit;
  Result := True;
end;

function ValidateUsername(Value: String): Boolean;
var
  i: Integer;
  ch: Char;
begin
  Result := False;
  Value := Trim(Value);
  if (Length(Value) < 1) or (Length(Value) > 64) then Exit;
  for i := 1 to Length(Value) do begin
    ch := Value[i];
    if not (((ch >= 'A') and (ch <= 'Z')) or
            ((ch >= 'a') and (ch <= 'z')) or
            ((ch >= '0') and (ch <= '9')) or
            (ch = '_') or (ch = '.') or (ch = '-')) then Exit;
  end;
  Result := True;
end;

function ValidateHostname(Value: String): Boolean;
var
  i: Integer;
begin
  Result := False;
  Value := Trim(Value);
  if (Length(Value) < 1) or (Length(Value) > 253) then Exit;
  for i := 1 to Length(Value) do
    if not IsHostnameLikeChar(Value[i]) then Exit;
  Result := True;
end;

function ValidatePort(Value: String): Boolean;
var
  i, n, code: Integer;
begin
  Result := False;
  Value := Trim(Value);
  if Value = '' then begin Result := True; Exit; end; // blank → default
  for i := 1 to Length(Value) do
    if (Value[i] < '0') or (Value[i] > '9') then Exit;
  Val(Value, n, code);
  if code <> 0 then Exit;
  if (n < 1) or (n > 65535) then Exit;
  Result := True;
end;

// ── Token capture (post-install) ────────────────────────────────────
function ExtractPeerTokenFromLog(LogPath: String): String;
var
  Lines: TArrayOfString;
  i, j, p: Integer;
  L, Tok: String;
begin
  Result := '';
  if not LoadStringsFromFile(LogPath, Lines) then Exit;
  for i := 0 to GetArrayLength(Lines) - 1 do begin
    L := Lines[i];
    p := Pos('phk_', L);
    if p > 0 then begin
      Tok := Copy(L, p, Length(L) - p + 1);
      // Trim to the first whitespace / quote / parenthesis / control char.
      j := 1;
      while (j <= Length(Tok)) and (Tok[j] <> ' ') and (Tok[j] <> #9)
        and (Tok[j] <> '"') and (Tok[j] <> '''') and (Tok[j] <> ')')
        and (Tok[j] <> ']') and (Tok[j] <> #13) and (Tok[j] <> #10) do
        Inc(j);
      Result := Copy(Tok, 1, j - 1);
      Exit;
    end;
  end;
end;

// ── Inline error label helpers ──────────────────────────────────────
function MakeErrorLabel(ParentPage: TWizardPage): TNewStaticText;
var
  L: TNewStaticText;
begin
  L := TNewStaticText.Create(WizardForm);
  L.Parent     := ParentPage.Surface;
  L.AutoSize   := False;
  L.Left       := 0;
  L.Top        := ParentPage.SurfaceHeight - ScaleY(28);
  L.Width      := ParentPage.SurfaceWidth;
  L.Height     := ScaleY(24);
  L.WordWrap   := True;
  L.Font.Color := ERR_COLOR;
  L.Caption    := '';
  Result := L;
end;

procedure ClearError(L: TNewStaticText);
begin
  if Assigned(L) then L.Caption := '';
end;

procedure ShowError(L: TNewStaticText; Msg: String);
begin
  if Assigned(L) then L.Caption := Msg;
end;

// ── Viewer discovery handlers ───────────────────────────────────────
procedure ViewerHubsListClick(Sender: TObject);
var
  idx: Integer;
begin
  idx := ViewerHubsListBox.ItemIndex;
  if (idx < 0) or (idx >= GetArrayLength(DiscoveredHosts)) then Exit;
  ViewerPage.Values[0] := DiscoveredHosts[idx];
  ViewerPage.Values[1] := DiscoveredPorts[idx];
  ClearError(ViewerErrLabel);
end;

procedure DiscoverHubsClick(Sender: TObject);
var
  ScriptPath, OutPath, Params: String;
  ResultCode, i, sep1, sep2: Integer;
  Lines: TArrayOfString;
  Line, InstName, Host, Port: String;
begin
  ViewerStatusLabel.Caption := 'Searching the LAN for Hawk Eye hubs (~5s)...';
  ViewerHubsListBox.Items.Clear;
  SetArrayLength(DiscoveredHosts, 0);
  SetArrayLength(DiscoveredPorts, 0);
  WizardForm.Update;

  ScriptPath := ExpandConstant('{tmp}\discover-hubs.ps1');
  OutPath    := ExpandConstant('{tmp}\hawkeye-discovered.txt');
  // ExtractTemporaryFile pulls the script from the [Files] section
  // staged at install time — but the discovery script is in
  // script-shims\ which is only extracted to {app} after [Files] runs,
  // so we read it from there instead. To keep this usable BEFORE
  // [Files] runs (the wizard pages are shown earlier than [Files]),
  // build.ps1 also stages discover-hubs.ps1 into {tmp} via a helper
  // [Files] entry below — see ExtractDiscoveryScript.
  if not FileExists(ScriptPath) then begin
    ViewerStatusLabel.Caption := 'Discovery helper not yet extracted; type the hub address manually.';
    Exit;
  end;

  Params := '-ExecutionPolicy Bypass -NoProfile -File "' + ScriptPath +
            '" -OutputFile "' + OutPath + '"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
              Params, ExpandConstant('{tmp}'),
              SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    ViewerStatusLabel.Caption := 'Could not launch discovery helper. Type the hub address manually.';
    Exit;
  end;

  if not LoadStringsFromFile(OutPath, Lines) then begin
    ViewerStatusLabel.Caption := 'Discovery produced no output. Type the hub address manually.';
    Exit;
  end;

  for i := 0 to GetArrayLength(Lines) - 1 do begin
    Line := Lines[i];
    if (Line = '') or (Line[1] = '#') then Continue;
    sep1 := Pos('|', Line);
    if sep1 <= 0 then Continue;
    InstName := Copy(Line, 1, sep1 - 1);
    sep2 := Pos('|', Copy(Line, sep1 + 1, Length(Line)));
    if sep2 <= 0 then Continue;
    Host := Copy(Line, sep1 + 1, sep2 - 1);
    Port := Copy(Line, sep1 + sep2 + 1, Length(Line));
    SetArrayLength(DiscoveredHosts, GetArrayLength(DiscoveredHosts) + 1);
    SetArrayLength(DiscoveredPorts, GetArrayLength(DiscoveredPorts) + 1);
    DiscoveredHosts[GetArrayLength(DiscoveredHosts) - 1] := Host;
    DiscoveredPorts[GetArrayLength(DiscoveredPorts) - 1] := Port;
    ViewerHubsListBox.Items.Add(InstName + '   (' + Host + ':' + Port + ')');
  end;

  if ViewerHubsListBox.Items.Count = 0 then
    ViewerStatusLabel.Caption := 'No hubs found. Make sure mDNS is enabled on the hub, or type the address manually.'
  else
    ViewerStatusLabel.Caption :=
      'Found ' + IntToStr(ViewerHubsListBox.Items.Count) +
      ' hub(s). Click one to fill the address, then Next.';
end;

// ── Wizard pages ────────────────────────────────────────────────────
procedure InitializeWizard;
begin
  // Page 2: role picker.
  RolePage := CreateInputOptionPage(wpWelcome,
    'Choose the role for this PC',
    'Hawk Eye supports four roles. Pick the one that matches what this computer will do.',
    'You can change this later only by uninstalling and re-installing.',
    True,   // exclusive (radio buttons)
    False); // ListBox
  RolePage.Add('Operation Pilot PC (Squadron Hub)' + CRLF +
    '   Stores your squadron''s sortie / pilot data. One per squadron.');
  RolePage.Add('Wing Commander PC (Aggregator)' + CRLF +
    '   Rolls up several squadrons into one wing-level dashboard.');
  RolePage.Add('Base Commander PC (Aggregator)' + CRLF +
    '   Rolls up several wings into one base-level dashboard.');
  RolePage.Add('Squadron / Flight Commander Laptop (Viewer only)' + CRLF +
    '   No data stored here; reads from the squadron hub PC.');
  RolePage.SelectedValueIndex := 0;
  SelectedRole := 0;

  // Hub-only page.
  HubPage := CreateInputQueryPage(RolePage.ID,
    'Squadron Hub setup',
    'Enter the squadron name and the first super-admin account.',
    'The squadron name becomes the Windows computer name (e.g. tigers-hub) so this PC is reachable on the LAN as <name>.local. 1-15 chars, letters/digits/hyphen, not all digits, no leading/trailing hyphen.');
  HubPage.Add('Squadron name (e.g. tigers-hub):',                                 False);
  HubPage.Add('Postgres superuser password (set when you installed Postgres):',   True);
  HubPage.Add('First super-admin username:',                                       False);
  HubPage.Add('First super-admin password (>= 8 chars):',                          True);
  HubPage.Add('Confirm super-admin password:',                                     True);
  HubErrLabel := MakeErrorLabel(HubPage);

  // Hub-only mDNS toggle.
  HubMdnsPage := CreateInputOptionPage(HubPage.ID,
    'Optional: advertise this hub on the LAN',
    'If enabled, Wing/Base PCs auto-discover this hub as _hawkeye-hub._tcp on the LAN. Leave off on networks that block multicast.',
    'You can turn this on later with scripts\lan-host\register-mdns.ps1.',
    False, // not exclusive — single checkbox
    False);
  HubMdnsPage.Add('Yes, advertise this hub on the LAN (recommended on quiet LANs)');
  HubMdnsPage.Values[0] := False;

  // Wing/Base aggregator share one page (chosen role determines INSTALL_PROFILE downstream).
  AggregatorPage := CreateInputQueryPage(RolePage.ID,
    'Aggregator PC setup',
    'Enter the hostname for this PC, the local Postgres password, and the first super-admin account.',
    'The hostname becomes the Windows computer name (e.g. wing-1, hq-base). 1-15 chars, letters/digits/hyphen. After install, add squadron hubs from the dashboard''s Address Book or by running scripts\lan-host\add-squadron-peer.ps1.');
  AggregatorPage.Add('Aggregator hostname (e.g. wing-1, hq-base):', False);
  AggregatorPage.Add('Postgres superuser password:',                       True);
  AggregatorPage.Add('First super-admin username:',                         False);
  AggregatorPage.Add('First super-admin password (>= 8 chars):',            True);
  AggregatorPage.Add('Confirm super-admin password:',                       True);
  AggregatorErrLabel := MakeErrorLabel(AggregatorPage);

  // Viewer page + discovery controls.
  ViewerPage := CreateInputQueryPage(RolePage.ID,
    'Viewer laptop setup',
    'Tell this laptop which squadron hub PC to talk to.',
    'No data is stored on this PC. Sign-in still happens against the hub. Click "Discover hubs on the LAN" to scan automatically (requires Bonjour / mDNS).');
  ViewerPage.Add('Squadron hub address (hostname like tigers-hub.local, or IP):',   False);
  ViewerPage.Add('Hub port (default 3847):',                                         False);
  ViewerPage.Values[1] := '3847';

  // Discover button — placed below the input fields.
  ViewerDiscoverBtn := TNewButton.Create(WizardForm);
  ViewerDiscoverBtn.Parent  := ViewerPage.Surface;
  ViewerDiscoverBtn.Left    := 0;
  ViewerDiscoverBtn.Top     := ScaleY(80);
  ViewerDiscoverBtn.Width   := ScaleX(220);
  ViewerDiscoverBtn.Height  := ScaleY(26);
  ViewerDiscoverBtn.Caption := 'Discover hubs on the LAN';
  ViewerDiscoverBtn.OnClick := @DiscoverHubsClick;

  ViewerStatusLabel := TNewStaticText.Create(WizardForm);
  ViewerStatusLabel.Parent   := ViewerPage.Surface;
  ViewerStatusLabel.Left     := ScaleX(230);
  ViewerStatusLabel.Top      := ScaleY(85);
  ViewerStatusLabel.AutoSize := False;
  ViewerStatusLabel.Width    := ViewerPage.SurfaceWidth - ScaleX(230);
  ViewerStatusLabel.Height   := ScaleY(20);
  ViewerStatusLabel.Caption  := '';

  ViewerHubsListBox := TNewListBox.Create(WizardForm);
  ViewerHubsListBox.Parent  := ViewerPage.Surface;
  ViewerHubsListBox.Left    := 0;
  ViewerHubsListBox.Top     := ScaleY(112);
  ViewerHubsListBox.Width   := ViewerPage.SurfaceWidth;
  ViewerHubsListBox.Height  := ScaleY(110);
  ViewerHubsListBox.OnClick := @ViewerHubsListClick;

  ViewerErrLabel := MakeErrorLabel(ViewerPage);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Pull the latest selection (the operator may have gone Back to change it).
  if Assigned(RolePage) then SelectedRole := RolePage.SelectedValueIndex;

  Result := False;
  if (PageID = HubPage.ID) or (PageID = HubMdnsPage.ID) then
    Result := not IsRoleHub
  else if PageID = AggregatorPage.ID then
    Result := not IsRoleAggregator
  else if PageID = ViewerPage.ID then
    Result := not IsRoleViewer;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if CurPageID = RolePage.ID then begin
    SelectedRole := RolePage.SelectedValueIndex;
    Exit;
  end;

  if CurPageID = HubPage.ID then begin
    ClearError(HubErrLabel);
    if not ValidateLanHostName(HubPage.Values[0]) then begin
      ShowError(HubErrLabel, 'Squadron name must be 1-15 chars, letters/digits/hyphen only, not all digits, no leading/trailing hyphen.');
      Result := False; Exit;
    end;
    if Trim(HubPage.Values[1]) = '' then begin
      ShowError(HubErrLabel, 'Postgres password cannot be empty.');
      Result := False; Exit;
    end;
    if not ValidateUsername(HubPage.Values[2]) then begin
      ShowError(HubErrLabel, 'Super-admin username must be 1-64 chars, letters/digits/._- only.');
      Result := False; Exit;
    end;
    if Length(HubPage.Values[3]) < 8 then begin
      ShowError(HubErrLabel, 'Super-admin password must be at least 8 characters.');
      Result := False; Exit;
    end;
    if HubPage.Values[3] <> HubPage.Values[4] then begin
      ShowError(HubErrLabel, 'Super-admin password and its confirmation do not match.');
      Result := False; Exit;
    end;
    Exit;
  end;

  if CurPageID = AggregatorPage.ID then begin
    ClearError(AggregatorErrLabel);
    if not ValidateLanHostName(AggregatorPage.Values[0]) then begin
      ShowError(AggregatorErrLabel, 'Aggregator hostname must be 1-15 chars, letters/digits/hyphen only, not all digits, no leading/trailing hyphen.');
      Result := False; Exit;
    end;
    if Trim(AggregatorPage.Values[1]) = '' then begin
      ShowError(AggregatorErrLabel, 'Postgres password cannot be empty.');
      Result := False; Exit;
    end;
    if not ValidateUsername(AggregatorPage.Values[2]) then begin
      ShowError(AggregatorErrLabel, 'Super-admin username must be 1-64 chars, letters/digits/._- only.');
      Result := False; Exit;
    end;
    if Length(AggregatorPage.Values[3]) < 8 then begin
      ShowError(AggregatorErrLabel, 'Super-admin password must be at least 8 characters.');
      Result := False; Exit;
    end;
    if AggregatorPage.Values[3] <> AggregatorPage.Values[4] then begin
      ShowError(AggregatorErrLabel, 'Super-admin password and its confirmation do not match.');
      Result := False; Exit;
    end;
    Exit;
  end;

  if CurPageID = ViewerPage.ID then begin
    ClearError(ViewerErrLabel);
    if not ValidateHostname(ViewerPage.Values[0]) then begin
      ShowError(ViewerErrLabel, 'Hub address must be a hostname (e.g. tigers-hub.local) or IP. Letters/digits/._- only.');
      Result := False; Exit;
    end;
    if not ValidatePort(ViewerPage.Values[1]) then begin
      ShowError(ViewerErrLabel, 'Hub port must be a number between 1 and 65535 (or blank for default 3847).');
      Result := False; Exit;
    end;
    Exit;
  end;
end;

// ── Discovery script extraction ─────────────────────────────────────
// Stage discover-hubs.ps1 into {tmp} BEFORE the wizard's viewer page
// is shown, since [Files] doesn't run until the operator clicks
// Install. We piggyback on Inno's "extra files" mechanism by listing
// the same source under [Files] with the "dontcopy" flag and
// extracting it on demand.
procedure ExtractDiscoveryScript;
var
  TmpPath: String;
begin
  TmpPath := ExpandConstant('{tmp}\discover-hubs.ps1');
  if not FileExists(TmpPath) then
    ExtractTemporaryFile('discover-hubs.ps1');
end;

// Write the credential file just before [Run] starts. PrepareToInstall
// is the latest hook before [Files]/[Run]. Returning '' = continue.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  CredPath, Body: String;
begin
  Result := '';
  // Hub + Aggregator are the only roles with passwords to hand off.
  if not (IsRoleHub or IsRoleAggregator) then Exit;

  CredPath := ExpandConstant('{tmp}\hawkeye-creds.txt');
  if IsRoleHub then
    Body := HubPage.Values[1] + #13#10 + HubPage.Values[3] + #13#10
  else
    Body := AggregatorPage.Values[1] + #13#10 + AggregatorPage.Values[3] + #13#10;

  if not SaveStringToFile(CredPath, Body, False) then begin
    Result := 'Could not write the temporary credential file at ' + CredPath +
              '. Re-run the installer or check %TEMP% permissions.';
    Exit;
  end;
end;

// ── Copy-to-clipboard handler for the post-install peer token ───────
procedure CopyTokenButtonClick(Sender: TObject);
var
  ResultCode: Integer;
  Tmp: String;
begin
  if CapturedPeerToken = '' then Exit;
  // clip.exe reads stdin. Write the token to a temp file, then "type" it
  // into clip via cmd /c.
  Tmp := ExpandConstant('{tmp}\peer-token.txt');
  SaveStringToFile(Tmp, CapturedPeerToken, False);
  Exec(ExpandConstant('{cmd}'),
    '/c type "' + Tmp + '" | clip',
    ExpandConstant('{tmp}'),
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  DeleteFile(Tmp);
  CopyButton.Caption := 'Copied!';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogPath: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if not IsRoleHub then Exit;

  LogPath := ExpandConstant('{app}\install-log.txt');
  CapturedPeerToken := ExtractPeerTokenFromLog(LogPath);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // Stage the discovery script lazily the first time the viewer page
  // is shown.
  if (CurPageID = ViewerPage.ID) and IsRoleViewer then
    ExtractDiscoveryScript;

  if CurPageID <> wpFinished then Exit;
  if not IsRoleHub then Exit;
  if CapturedPeerToken = '' then Exit;
  if Assigned(TokenPanel) then Exit; // already added (Back/Next round-trip)

  TokenPanel := TPanel.Create(WizardForm);
  TokenPanel.Parent  := WizardForm.FinishedPage;
  TokenPanel.Left    := ScaleX(8);
  TokenPanel.Top     := ScaleY(140);
  TokenPanel.Width   := WizardForm.FinishedPage.ClientWidth - ScaleX(16);
  TokenPanel.Height  := ScaleY(96);
  TokenPanel.BevelOuter := bvLowered;
  TokenPanel.Color := $00B5E6B5; // soft green (BGR)

  TokenLabel := TNewStaticText.Create(WizardForm);
  TokenLabel.Parent  := TokenPanel;
  TokenLabel.Left    := ScaleX(12);
  TokenLabel.Top     := ScaleY(8);
  TokenLabel.AutoSize := False;
  TokenLabel.Width   := TokenPanel.ClientWidth - ScaleX(24);
  TokenLabel.Height  := ScaleY(34);
  TokenLabel.WordWrap := True;
  TokenLabel.Caption :=
    'Peer access token (give this to the Wing/Base Commander PC operator — shown once):';

  TokenValueBox := TNewEdit.Create(WizardForm);
  TokenValueBox.Parent  := TokenPanel;
  TokenValueBox.Left    := ScaleX(12);
  TokenValueBox.Top     := ScaleY(46);
  TokenValueBox.Width   := TokenPanel.ClientWidth - ScaleX(120);
  TokenValueBox.Height  := ScaleY(22);
  TokenValueBox.ReadOnly := True;
  TokenValueBox.Text    := CapturedPeerToken;

  CopyButton := TNewButton.Create(WizardForm);
  CopyButton.Parent  := TokenPanel;
  CopyButton.Left    := TokenValueBox.Left + TokenValueBox.Width + ScaleX(8);
  CopyButton.Top     := TokenValueBox.Top - ScaleY(2);
  CopyButton.Width   := ScaleX(86);
  CopyButton.Height  := ScaleY(26);
  CopyButton.Caption := 'Copy';
  CopyButton.OnClick := @CopyTokenButtonClick;
end;
