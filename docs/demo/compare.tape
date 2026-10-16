# Records docs/demo/compare.gif and compare.mp4 from the real CLI. Run from the repository root
# after `npm run build`:
#   vhs docs/demo/compare.tape
# Nothing is scripted output: every frame is what the built hexvero prints for the example builds.
Output docs/demo/compare.gif
Output docs/demo/compare.mp4
Set Shell bash
Set FontSize 14
Set Width 1240
Set Height 860
Set Padding 24
Set TypingSpeed 30ms
Set Theme { "name": "hexvero", "black": "#1B1D21", "red": "#E5786D", "green": "#8FBF7F", "yellow": "#F2B84B", "blue": "#7AA6DA", "magenta": "#C594C5", "cyan": "#6FC3C3", "white": "#D8D5CC", "brightBlack": "#6B6F78", "brightRed": "#E5786D", "brightGreen": "#8FBF7F", "brightYellow": "#F2B84B", "brightBlue": "#7AA6DA", "brightMagenta": "#C594C5", "brightCyan": "#6FC3C3", "brightWhite": "#F4F1EA", "background": "#1B1D21", "foreground": "#D8D5CC", "selection": "#3A3D45", "cursor": "#F2B84B" }

Hide
Type `hexvero() { node "$OLDPWD/packages/cli/bin/hexvero.js" "$@"; }; cd "$(mktemp -d)"; export PS1='\[\e[38;5;214m\]$\[\e[0m\] '; clear`
Enter
Show

Type "hexvero demo"
Sleep 400ms
Enter
Sleep 9s

Type "clear; hexvero compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --report report.md | tail -4"
Sleep 400ms
Enter
Sleep 3s

Type "sed -n '/## Not established/,/## Reproduce/p' report.md"
Sleep 400ms
Enter
Sleep 6s
