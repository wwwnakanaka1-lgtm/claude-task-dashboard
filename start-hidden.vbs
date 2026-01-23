Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\wwwhi\Create\claude-task-dashboard"
shell.Run "node server.js", 0, False
WScript.Sleep 2000
shell.Run "http://localhost:3456", 0, False
