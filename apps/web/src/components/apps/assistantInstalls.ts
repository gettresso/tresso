/**
 * How each assistant adds Tresso, on the AI assistants page. Only forms their makers document are used, and never a
 * token or secret: every assistant signs in with OAuth in the browser.
 *
 * - Claude Code: `claude mcp add --transport http <name> <url>`, then `/mcp` in Claude Code to sign in
 *   (code.claude.com/docs/en/mcp).
 * - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the JSON config>`
 *   (cursor.com/docs/mcp/install-links), with the config of a remote server, `{"url": ...}` (cursor.com/docs/context/mcp).
 * - Claude documents no install link with the address filled in (support.claude.com custom connectors), nor does
 *   ChatGPT: their panels have the manual steps. VS Code keeps the manual steps until its install link is checked with
 *   a remote server.
 *
 * The endpoint comes from the server, and goes into a command a user pastes in a terminal and a link the system
 * opens: it is used only when {@see checkedEndpoint()} accepts it.
 */
export type InstallId = 'claude' | 'claude-code' | 'cursor' | 'vscode' | 'chatgpt' | 'other'

export interface Install {
  id: InstallId
  name: string
  mark: string
  effort: string
  kind: 'link' | 'command' | 'steps'
  title: string
  text: string
  button?: string
  url?: string
  command?: string
  steps?: string[]
}

/** The name Tresso has in an assistant's list of servers. */
export const SERVER_NAME = 'tresso'

const MANUAL_STEPS = ['Paste your endpoint URL.', 'Sign in and approve the permissions it asks for.', 'It shows up below. Narrow its permissions any time.']

/** Anything a shell or a link could read as more than an address. */
const UNSAFE = /[^A-Za-z0-9._~:/%-]/

/**
 * The MCP endpoint when it is a plain address an assistant can be pointed at: https (http only on this computer), no
 * user or password, no query or fragment, plain ASCII without spaces or characters a shell treats specially. Null for
 * anything else, also a missing value.
 */
export function checkedEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 2048 || UNSAFE.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') return null
  // What the URL parser made of it must be what was given (no decoding, no hidden host).
  return url.href === value || url.href === `${value}/` ? value : null
}

/** Cursor's install link for a remote server at this address (a checked one). */
export function cursorInstallLink(endpoint: string): string {
  const config = btoa(JSON.stringify({ url: endpoint }))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(config)}`
}

/** Claude Code's command for a remote server at this address (a checked one), the address in single quotes. */
export function claudeCodeCommand(endpoint: string): string {
  return `claude mcp add --transport http ${SERVER_NAME} '${endpoint}'`
}

/** The panels; without a checked endpoint there is no command and no link to give. */
export function installs(endpoint: string | null): Install[] {
  return [
    {
      id: 'claude',
      name: 'Claude',
      mark: 'CL',
      effort: 'A few steps',
      kind: 'steps',
      title: 'Add Tresso to Claude',
      text: 'Claude has no install link. Copy your MCP endpoint below and follow these steps.',
      steps: ['In Claude, add a custom connector.', ...MANUAL_STEPS],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      mark: 'CC',
      effort: 'One command',
      kind: 'command',
      title: 'Add Tresso to Claude Code',
      text: 'Paste this line in your terminal. Then type /mcp in Claude Code and choose tresso to sign in.',
      ...(endpoint === null ? {} : { command: claudeCodeCommand(endpoint) }),
    },
    {
      id: 'cursor',
      name: 'Cursor',
      mark: 'CU',
      effort: 'One click',
      kind: 'link',
      button: 'Add to Cursor',
      title: 'Add Tresso to Cursor',
      text: 'Opens Cursor and asks to install the Tresso MCP server. Choose Install there, then sign in to Tresso.',
      ...(endpoint === null ? {} : { url: cursorInstallLink(endpoint) }),
    },
    {
      id: 'vscode',
      name: 'VS Code',
      mark: 'VS',
      effort: 'A few steps',
      kind: 'steps',
      title: 'Add Tresso to VS Code',
      text: 'Copy your MCP endpoint below and follow these steps.',
      steps: ['In VS Code, add an MCP server.', ...MANUAL_STEPS],
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      mark: 'CG',
      effort: 'A few steps',
      kind: 'steps',
      title: 'Add Tresso to ChatGPT',
      text: 'ChatGPT has no install link. Copy your MCP endpoint below and follow these steps.',
      steps: ['In ChatGPT, add a custom connector.', ...MANUAL_STEPS],
    },
    {
      id: 'other',
      name: 'Other',
      mark: '+',
      effort: 'A few steps',
      kind: 'steps',
      title: 'Add Tresso to another AI tool',
      text: 'Works with every tool that supports remote MCP servers. Copy your MCP endpoint below and follow these steps.',
      steps: ['In your AI tool, add a remote MCP server.', ...MANUAL_STEPS],
    },
  ]
}
