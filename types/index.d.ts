export type ChatMessage = {
  id: string
  time: number
  from: string
  cid: string
  text: string
}

export type ChatSetup = { name: string; room: string; clientId: string }

declare module 'claude-code' {
  interface PluginState {
    'side-chat': {
      setup: Shaped<ChatSetup>
      messages: Shaped<ChatMessage[]>
      isPrimed: boolean
      notice: string
      sent: number
    }
  }
}
