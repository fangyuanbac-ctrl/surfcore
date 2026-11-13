' 鲸眠日记阅读器启动器（wscript，无控制台窗口）
' 1) 探 127.0.0.1:8787/health；2) 没起就在后台起 node diary-viewer.mjs；3) 打开浏览器
Option Explicit

Dim sh, fso, here, repo, url, i, ok, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetParentFolderName(here)
url = "http://127.0.0.1:8787/"

nodeExe = "C:\Users\1\AppData\Local\Programs\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

ok = False
For i = 1 To 3
  If Probe(url & "health") Then
    ok = True
    Exit For
  End If
  sh.CurrentDirectory = repo
  sh.Run """" & nodeExe & """ """ & here & "\diary-viewer.mjs""", 0, False
  WScript.Sleep 1500
Next

sh.Run url, 1, False

Function Probe(u)
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", u, False
  x.Send
  Probe = (Err.Number = 0 And x.Status = 200)
  Err.Clear
End Function
