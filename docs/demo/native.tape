# Records docs/demo/native.gif (native triage without a decompiler, then a call path through
# radare2) from the real CLI. Run from the repository root after `npm run build`:
#   vhs docs/demo/demo.tape
# Requires vhs (https://github.com/charmbracelet/vhs). Nothing here is scripted output: every
# frame is what the built hexvero prints for the files in examples/.
Output docs/demo/native.gif
Set Shell bash
Set FontSize 15
Set Width 1180
Set Height 720
Set Padding 24
Set TypingSpeed 28ms
Set Theme { "name": "hexvero", "black": "#1B1D21", "red": "#E5786D", "green": "#8FBF7F", "yellow": "#F2B84B", "blue": "#7AA6DA", "magenta": "#C594C5", "cyan": "#6FC3C3", "white": "#D8D5CC", "brightBlack": "#6B6F78", "brightRed": "#E5786D", "brightGreen": "#8FBF7F", "brightYellow": "#F2B84B", "brightBlue": "#7AA6DA", "brightMagenta": "#C594C5", "brightCyan": "#6FC3C3", "brightWhite": "#F4F1EA", "background": "#1B1D21", "foreground": "#D8D5CC", "selection": "#3A3D45", "cursor": "#F2B84B" }

Hide
Type `hexvero() { node "$OLDPWD/packages/cli/bin/hexvero.js" "$@"; }; cd "$(mktemp -d)"; cc -O2 -o demo "$OLDPWD/examples/native/demo-v2.c"; export PS1='\[\e[38;5;214m\]$\[\e[0m\] '; clear`
Enter
Show

Type "hexvero analyze demo"
Sleep 400ms
Enter
Sleep 4s

Type "hexvero collection demo imports"
Sleep 400ms
Enter
Sleep 3s

Type "hexvero calls demo radare2 main --goal system"
Sleep 400ms
Enter
Sleep 5s
