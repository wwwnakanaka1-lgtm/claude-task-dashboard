param(
  [string]$OutPath = \"\",
  [int]$MaxFileSizeKb = 200,
  [int]$MaxTotalKb = 800,
  [switch]$IncludeDocs
)
& "C:\Users\wwwhi\Create\repo-review-bundle.ps1" -OutPath $OutPath -MaxFileSizeKb $MaxFileSizeKb -MaxTotalKb $MaxTotalKb -IncludeDocs:$IncludeDocs
