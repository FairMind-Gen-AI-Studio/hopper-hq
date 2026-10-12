export type AttentionItem = {
  id: string
  name: string | null
  repo: string
  state: 'needs_you' | 'done'
  since: number
  reason: { kind: string; text: string; detail?: string } | null
  title: string | null
  tmuxPane: string | null
  // The tmux session the pane is in; null when unknown, absent from a daemon that predates it.
  tmuxSession?: string | null
}

export type Attention = { needsYou: number; done: number; items: AttentionItem[] }

declare module 'claude-code' {
  interface PluginState {
    'scranton-hq': { attention: Attention | null }
  }
}
