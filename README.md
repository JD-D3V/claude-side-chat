# side-chat

A mod for Claude Code and the Claude desktop app's Code tab. It adds a pane
beside the chat where you and a friend who has the same mod send each other
messages. Claude never reads the messages; they are only drawn in the pane.

## Install

At the prompt of a Claude Code terminal session:

    /plugin install side-chat --marketplace JD-D3V/claude-side-chat

Answer `y` to add the marketplace, then pick a scope (the user scope is first).

From a shell:

    claude plugin install side-chat --marketplace JD-D3V/claude-side-chat

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `JD-D3V/claude-side-chat`, then Add
plugin.

## Use

The "Friend chat" pane opens by itself in a new session; `/friend` opens it
again if you close it. Type your name, then either press "Start a new chat"
and send the code to your friend, or paste the code your friend sent you into
"Or join with a code". The code is saved, so you enter it once.

When your friend writes, you get a popup in Claude and a system notification.
"Mute" in the pane turns both off; "Copy invite code" copies your code again.

## Good to know

- Messages go through ntfy.sh, a free public relay, and are not end-to-end
  encrypted. Anyone who has the chat code can read and post, so share the code
  privately and keep passwords out of the chat.
- The relay keeps messages for about 12 hours. Messages take up to about 8
  seconds to arrive.
- Nothing else has to be running: only Claude, with a session open.
