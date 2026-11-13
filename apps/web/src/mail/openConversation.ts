import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

/**
 * What the conversation open in the reading pane offers to the desktop app's Message menu (platform/menu.ts): the
 * pane's own actions, so a menu item does exactly what the pane's button or key does (undo notices and the instant
 * change included), and the state the menu's titles follow.
 */
export interface ConversationCommands {
  /**
   * Whether the conversation is on screen and has the user's attention: loaded, no conversations selected in the list,
   * no hand-over dialog open. The pane's own keys wait otherwise, and so does the menu.
   */
  ready(): boolean
  /** All its messages are read: the menu offers Mark as Unread. */
  read(): boolean
  /** One of its messages is flagged: the menu offers Unflag. */
  flagged(): boolean
  /** Opens a reply, reply to all or forward of its newest message, as that message's own buttons do. */
  reply(kind: 'reply' | 'replyAll' | 'forward'): Promise<void>
  archive(): Promise<void>
  trash(): Promise<void>
  /** Opens the pane's folder menu (Move to). */
  chooseFolder(): Promise<void>
  /** Marks it unread when it is read (as U does), read otherwise. */
  toggleRead(): Promise<void>
  /** Flags it, or takes its flags off (as S does). */
  toggleFlag(): Promise<void>
}

/** The panes that offer their commands, oldest first; the newest one mounted is the one on screen. */
const offered = shallowRef<ConversationCommands[]>([])

/** The open conversation's commands while it has the user's attention; null while none does. Reactive. */
export function openConversation(): ConversationCommands | null {
  const newest = offered.value[offered.value.length - 1]
  return newest !== undefined && newest.ready() ? newest : null
}

/** Offers the commands while the returned function is not called. */
export function offerConversation(commands: ConversationCommands): () => void {
  offered.value = [...offered.value, commands]
  return () => {
    offered.value = offered.value.filter((candidate) => candidate !== commands)
  }
}

/** For the reading pane: offers its commands while it is mounted. */
export function useConversationCommands(commands: ConversationCommands): void {
  let stop: (() => void) | null = null
  onMounted(() => {
    stop = offerConversation(commands)
  })
  onBeforeUnmount(() => stop?.())
}
