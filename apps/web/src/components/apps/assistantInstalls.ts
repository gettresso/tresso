/**
 * How each assistant adds Tresso, on the AI assistants page. Only forms their makers document are used, and never a
 * token or secret: every assistant signs in with OAuth in the browser.
 *
 * - Claude Code: `claude mcp add --transport http <name> <url>`, then `/mcp` in Claude Code to sign in
 *   (code.claude.com/docs/en/mcp).
 * - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the JSON config>`
 *   (cursor.com/docs/mcp/install-links), with the config of a remote server, `{"url": ...}` (cursor.com/docs/context/mcp).
 * - Claude and VS Code document no install link with the address filled in (support.claude.com custom connectors;
 *   code.visualstudio.com MCP configuration reference), and ChatGPT none at all: their panels have the manual steps.
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

/** Cursor's install link for a remote server at this address. */
export function cursorInstallLink(endpoint: string): string {
  const config = btoa(JSON.stringify({ url: endpoint }))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(config)}`
}

/** Claude Code's command for a remote server at this address. */
export function claudeCodeCommand(endpoint: string): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${endpoint}`
}

export function installs(endpoint: string): Install[] {
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
      command: claudeCodeCommand(endpoint),
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
      url: cursorInstallLink(endpoint),
    },
    {
      id: 'vscode',
      name: 'VS Code',
      mark: 'VS',
      effort: 'A few steps',
      kind: 'steps',
      title: 'Add Tresso to VS Code',
      text: 'VS Code has no install link. Copy your MCP endpoint below and follow these steps.',
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
