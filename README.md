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

The pane opens by itself the first time, to ask your name. After that
`/friend` opens it, and "Close" (top right of every page) or `/friend close`
closes it. It has five pages, each with "‹ Back" at the top left:

- **Messages**: your contacts, each with its last message, how long ago it
  came, and a mark when something is unread. "Open" opens a chat; "New chat"
  and "Settings" lead to those pages.
- **New chat**: "Create invite code" starts a chat and gives you a code to
  send to your friend; or paste a code a friend sent you and press "Join".
- **A chat**: the messages and the box to write in. Until your friend joins,
  the invite code and a "Copy invite code" button sit at the top.
- **Contact** ("Details" in a chat): give the contact a name of your own, copy
  the invite code again, or remove the contact.
- **Settings**: your name, and popups on or off, with a button to test them.

Each contact is saved with its key on your computer, so a code is entered
once. You can keep up to 20 contacts.

When a friend writes, a row appears above the prompt in Claude ("Open" /
"Dismiss"), and your computer shows a system notification, so you see it with
Claude in front or not.

## How it is protected

Messages are end-to-end encrypted. From the invite code the mod derives a
secret key, which never leaves your computer, and a separate relay address
that cannot be turned back into the code. Each message is sealed with
XChaCha20-Poly1305 before it is sent, padded so its size says little about
its length, and anything on the relay that does not open with the chat's key
is ignored.

- The relay (ntfy.sh, a free public service) sees sealed data, the relay
  address, and when and from which network address it was posted. It cannot
  read or change messages.
- Anyone who has the invite code can read the chat, so share codes privately.
- The code and key are kept in a plain file in your Claude folder
  (`~/.claude/plugins/store/`), readable by your own user account.
- The same key is used for the life of a chat: someone who records the sealed
  traffic and later gets the code could read the old messages.
- Claude does not read the chat; messages are only drawn in the pane.

Both people need version 0.3.0 or later. A chat started on an earlier version
keeps its code and moves to the encrypted format by itself.

## Good to know

- The relay keeps messages for about 12 hours, and its free tier allows about
  250 sent messages a day per network address.
- Messages arrive in well under a second while the pane says "Live": the mod
  keeps one `curl` connection open to the relay in the background. Where
  Claude cannot run commands, or there is no `curl`, it falls back to asking
  the relay every 3 to 8 seconds and says "Checking every few seconds".
- System notifications use `osascript` on macOS and `notify-send` on Linux.
  On Windows, or if those fail, Claude's own notification channel is used.
- Nothing else has to be running: only Claude, with a session open.

## Testing without a friend

`scripts/test-friend.ts` is a stand-in friend (it needs [Bun](https://bun.sh)).
Make a chat just for testing with "Start a new chat", then:

    bun scripts/test-friend.ts measure

sends three messages and prints how long the mod took to receive each, whether
delivery is live or polling, and how the popup went out. `listen` prints what
you send from the pane with its timing; `send` sends one message. The script
reads the chat's key from the mod's store, so no code is typed.

The encryption code in `hooks/vendor/` is `@noble/ciphers` and `@noble/hashes`
by Paul Miller (MIT), copied unmodified; see `hooks/vendor/README.md`.
