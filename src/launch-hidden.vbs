' CLIP STUDIO ASSETS translator hidden launcher.
' Uses WScript.Shell.Run window style 0 to keep node.exe invisible.
' The plugin directory may contain non-ASCII characters, so paths must be
' supplied as command-line arguments rather than embedded in this file.
' Arguments: node.exe path, daemon.js path.

Option Explicit

Dim fso, shell, nodeExe, daemonJs, cmd, wmi, procs, p, already

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then WScript.Quit 2

nodeExe = WScript.Arguments(0)
daemonJs = WScript.Arguments(1)

If Not fso.FileExists(nodeExe) Then WScript.Quit 3
If Not fso.FileExists(daemonJs) Then WScript.Quit 4

' Avoid duplicate daemon processes.
already = False
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 And Not wmi Is Nothing Then
    Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
    For Each p In procs
        If Not IsNull(p.CommandLine) Then
            If InStr(1, p.CommandLine, "daemon.js", vbTextCompare) > 0 Then
                already = True
                Exit For
            End If
        End If
    Next
End If
On Error GoTo 0

If already Then WScript.Quit 0

cmd = """" & nodeExe & """ """ & daemonJs & """"
shell.CurrentDirectory = fso.GetParentFolderName(daemonJs)
shell.Run cmd, 0, False
