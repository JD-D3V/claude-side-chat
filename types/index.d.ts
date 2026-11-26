/** One message as kept in the store and drawn: already opened. */
export type ChatMessage = {
  id: string
  time: number
  from: string
  cid: string
  text: string
  nonce: string
}

/** A saved chat. Kept in the store only: it holds the code and the key. */
export type Contact = {
  id: string
  label: string
  code: string
  key: string
  topic: string
  me: string
}

/** What the pane draws of a saved chat: nothing secret, since state is readable. */
export type ChatSummary = {
  id: string
  label: string
  mask: string
  me: string
  preview: string
  time: number
  unread: number
  seen: string
}

export type Profile = { name: string; isMuted: boolean }

/** The newest unseen message, for the row above the prompt. */
export type Alert = { chat: string; from: string; text: string; count: number }

declare module 'claude-code' {
  interface PluginState {
    'side-chat': {
      profile: Shaped<Profile>
      chats: Shaped<ChatSummary[]>
      messages: Shaped<ChatMessage[]>
      open: string
      notice: string
      sent: number
      isLeaving: boolean
      isRenaming: boolean
      minute: number
      alert: Alert | null
      transport: string
    }
  }
}
