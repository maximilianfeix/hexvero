# Records docs/demo/release-gate.gif and release-gate.mp4 from the real CLI: two releases, one
# relevant change with the places it was read from, an honest unknown, and the release policy that
# fails the build (exit 3). Run from the repository root after `npm run build`:
#   vhs docs/demo/release-gate.tape
# Nothing is scripted output: every frame is what the built hexvero prints for the example builds.
Output docs/demo/release-gate.gif
Output docs/demo/release-gate.mp4
Set Shell bash
Set FontSize 15
Set Width 1380
Set Height 720
Set Padding 24
Set TypingSpeed 25ms
Set Theme { "name": "hexvero", "black": "#1B1D21", "red": "#E5786D", "green": "#8FBF7F", "yellow": "#F2B84B", "blue": "#7AA6DA", "magenta": "#C594C5", "cyan": "#6FC3C3", "white": "#D8D5CC", "brightBlack": "#6B6F78", "brightRed": "#E5786D", "brightGreen": "#8FBF7F", "brightYellow": "#F2B84B", "brightBlue": "#7AA6DA", "brightMagenta": "#C594C5", "brightCyan": "#6FC3C3", "brightWhite": "#F4F1EA", "background": "#1B1D21", "foreground": "#D8D5CC", "selection": "#3A3D45", "cursor": "#F2B84B" }

Hide
Type `hexvero() { node "$OLDPWD/packages/cli/bin/hexvero.js" "$@"; }; cd "$(mktemp -d)"; export PS1='\[\e[38;5;214m\]$\[\e[0m\] '; clear`
Enter
Show

# Release A and release B of the example app (and the example policy)
Type "hexvero demo > /dev/null; ls hexvero-demo"
Sleep 300ms
Enter
Sleep 2.5s

Type "A=hexvero-demo/notesdesk-1.4.0.asar B=hexvero-demo/notesdesk-1.5.0.asar"
Sleep 200ms
Enter
Sleep 300ms

# What changed: a new member pages can call, its preload line and its main-process handler line,
# and a channel that is unknown, not "removed", because B computes channel names at run time
Hide
Type "clear"
Enter
Show
Type "hexvero compare $A $B --report report.md | head -10"
Sleep 300ms
Enter
Sleep 8s

# The same comparison as a release gate: the policy fails on the new member and the new host
Hide
Type "clear"
Enter
Show
Type "hexvero check $A $B --policy hexvero-demo/policy.json; echo exit $?"
Sleep 300ms
Enter
Sleep 9s
