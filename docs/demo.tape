# vhs script for the demo GIF: `vhs docs/demo.tape` writes docs/public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build)
#   * run it from the repository root, not from docs/
#
# No credentials, on purpose: the server starts without an API key, so this tape
# is reproducible by anyone from a fresh clone, and what it demonstrates — the
# tool filter — is the part a screenshot of somebody else's dashboard cannot show.
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * `-e` goes AFTER the command being launched, and the Inspector does not
#     inherit the shell environment: `X=1 npx … inspector …` silently applies
#     nothing at all
#   * three beats, no more

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 460
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Sleep 500ms
Show

Type "# twenty-one tools" Enter
Sleep 800ms
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list 2>/dev/null | jq -r '.tools[].name' | paste -sd' '" Enter
Sleep 12s

Type "# or five, curated" Enter
Sleep 800ms
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e GSC_ALLOW_TOOLS=essential --method tools/list 2>/dev/null | jq -r '.tools[].name' | paste -sd' '" Enter
Sleep 12s

Type "# a typo stops the server instead of quietly hiding a tool" Enter
Sleep 800ms
Type "GSC_ALLOW_TOOLS=list_sitez node dist/index.js 2>&1 | tail -1 | fold -sw 100" Enter
Sleep 6s
