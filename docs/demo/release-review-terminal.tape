# Terminal half of docs/demo/release-review.mp4 (the UI half is recorded by
# scripts/record-release-review.mjs). Run from the repository root after `npm run build`:
#   vhs docs/demo/release-review-terminal.tape
# Every frame is what the built hexvero prints for the example builds; setup happens off screen.
# `npx` is a shell function for the repository's build here, so the frames match this commit.
Output release-review-terminal.mp4
Set Shell bash
Set FontFamily "Menlo"
Set FontSize 17
Set LineHeight 1.35
Set Width 1280
Set Height 720
Set Padding 36
Set TypingSpeed 22ms
Set Theme { "name": "hexvero", "black": "#17191C", "red": "#E5736F", "green": "#8FC98A", "yellow": "#F2B84B", "blue": "#A3A7AF", "magenta": "#E8E6E1", "cyan": "#A3A7AF", "white": "#E8E6E1", "brightBlack": "#8E939D", "brightRed": "#E5736F", "brightGreen": "#8FC98A", "brightYellow": "#F2B84B", "brightBlue": "#A3A7AF", "brightMagenta": "#E8E6E1", "brightCyan": "#A3A7AF", "brightWhite": "#F4F1EA", "background": "#1B1D21", "foreground": "#E8E6E1", "selection": "#3A2F17", "cursor": "#F2B84B" }

Hide
Type `HX="$PWD/packages/cli/bin/hexvero.js"; npx() { node "$HX" "${@:2}"; }; cd "$(mktemp -d)"; export PS1='\[\e[38;5;214m\]$\[\e[0m\] '; clear`
Enter
Sleep 1s
Show

# Two builds of the example app, and what changed between them (first 16 lines)
Type "npx hexvero demo | head -16"
Sleep 250ms
Enter
Sleep 7s

# The same comparison as a release gate
Hide
Type "cd hexvero-demo; clear"
Enter
Show
Type "npx hexvero check notesdesk-1.4.0.asar notesdesk-1.5.0.asar --policy policy.json; echo exit $?"
Sleep 250ms
Enter
Sleep 6s
