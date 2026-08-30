Set WshShell = CreateObject("WScript.Shell")
' O-yuan autostart - silent background service startup
Set fso = CreateObject("Scripting.FileSystemObject")
fso.CreateTextFile "D:\DeepseekH\conclave\logs\autostart-marker.txt", True, True
WshShell.CurrentDirectory = "D:\DeepseekH\conclave"
WshShell.Run """D:\node.exe"" ""D:\DeepseekH\conclave\src\js\server.js""", 0, False
