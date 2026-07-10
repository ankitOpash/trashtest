Set fso = CreateObject("Scripting.FileSystemObject")
toolsDir = fso.GetParentFolderName(WScript.ScriptFullName)

title = "TeamLens Screenshot Alert"
msg = "Screenshot coming soon."
timeout = 30

titleFile = toolsDir & "\popup-title.txt"
msgFile = toolsDir & "\popup-msg.txt"
timeoutFile = toolsDir & "\popup-timeout.txt"

If fso.FileExists(titleFile) Then title = Trim(fso.OpenTextFile(titleFile, 1).ReadAll())
If fso.FileExists(msgFile) Then msg = fso.OpenTextFile(msgFile, 1).ReadAll()
If fso.FileExists(timeoutFile) Then timeout = CInt(Trim(fso.OpenTextFile(timeoutFile, 1).ReadAll()))

CreateObject("WScript.Shell").Popup msg, timeout, title, 48
