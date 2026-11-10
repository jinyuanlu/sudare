export type SudareConv = { id: string; topic: string; unread: number; pending: number; round: string | null }
export type SudareItem = { msg: string; conv: string; topic: string; from: string; text: string; state: string }
export type SudareDraft = { id: string; topic: string | null; kind: string; text: string; device: string; status: string }
export type SudareInvite = { id: string; topic: string; by: string; members: number }
export type SudareSeat = { round: string; conv: string; topic: string; goal: string; isSeated: boolean }

/** What the band and the pane draw: a cache of server state, never a source of truth. */
export type SudareSnapshot = {
  convs: SudareConv[]
  inbox: SudareItem[]
  drafts: SudareDraft[]
  invites: SudareInvite[]
  seats: SudareSeat[]
  at: number
}

export type SudareLine = { id: string; from: string; text: string; via: string; isMine: boolean }

/** The last messages of the conversation the person is looking at. */
export type SudarePerson = { handle: string; alias: string; isHere: boolean }
export type SudareTimeline = { conv: string; topic: string; me: string; others: SudarePerson[]; lines: SudareLine[]; canInvite: boolean }

/** A pending "confirm in your browser" request: the pairing code the person compares, and where to confirm. */
export type SudareLink = { code: string; url: string }

declare module 'claude-code' {
  interface PluginState {
    sudare: {
      snapshot: SudareSnapshot
      current: string | null
      timeline: SudareTimeline | null
      target: string | null
      compose: { isOpen: boolean; people: string[] }
      isHelpOpen: boolean
      isKept: boolean
      isConnected: boolean
      isNew: boolean
      link: SudareLink | null
      isSignedIn: boolean
      notice: string | null
    }
  }
}
