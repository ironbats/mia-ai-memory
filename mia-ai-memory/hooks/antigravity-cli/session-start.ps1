. "$PSScriptRoot\..\lib\ai-memory-hook.ps1"
Invoke-AiMemoryHook -Event "session-start" -Agent "antigravity-cli" -FetchHandoff -AntigravityPreInvocationOutput
exit 0
