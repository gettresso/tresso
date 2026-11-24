import { describe, expect, it } from 'vitest'
import { appInitials } from '../appMarks'
import { claudeCodeCommand, cursorInstallLink, installs } from '../assistantInstalls'

describe('assistant installs', () => {
  it('uses only the documented forms, with the endpoint and never a secret', () => {
    const endpoint = 'https://mcp.tresso.example/mcp'
    expect(claudeCodeCommand(endpoint)).toBe('claude mcp add --transport http tresso https://mcp.tresso.example/mcp')
    const link = new URL(cursorInstallLink(endpoint))
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('cursor://anysphere.cursor-deeplink/mcp/install')
    expect(link.searchParams.get('name')).toBe('tresso')
    expect(JSON.parse(atob(link.searchParams.get('config')!))).toEqual({ url: endpoint })
    expect(installs(endpoint).map((item) => [item.id, item.kind, item.effort])).toEqual([
      ['claude', 'steps', 'A few steps'],
      ['claude-code', 'command', 'One command'],
      ['cursor', 'link', 'One click'],
      ['vscode', 'steps', 'A few steps'],
      ['chatgpt', 'steps', 'A few steps'],
      ['other', 'steps', 'A few steps'],
    ])
  })

  it('marks an app with two letters', () => {
    expect(appInitials('Claude')).toBe('CL')
    expect(appInitials('ChatGPT')).toBe('CG')
    expect(appInitials('Cursor')).toBe('CU')
    expect(appInitials('Calendar bridge')).toBe('CB')
    expect(appInitials('  ')).toBe('')
  })
})
