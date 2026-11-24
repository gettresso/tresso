import { describe, expect, it } from 'vitest'
import { appInitials } from '../appMarks'
import { checkedEndpoint, claudeCodeCommand, cursorInstallLink, installs } from '../assistantInstalls'

describe('assistant installs', () => {
  it('uses only the documented forms, with the endpoint and never a secret', () => {
    const endpoint = 'https://mcp.tresso.example/mcp'
    expect(claudeCodeCommand(endpoint)).toBe('claude mcp add --transport http tresso https://mcp.tresso.example/mcp')
    expect(claudeCodeCommand(endpoint)).not.toMatch(/['"]/)
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

  it('takes only a plain address as the endpoint, and gives no command or link without one', () => {
    expect(checkedEndpoint('https://mcp.tresso.example/mcp')).toBe('https://mcp.tresso.example/mcp')
    expect(checkedEndpoint('http://localhost:8080/mcp')).toBe('http://localhost:8080/mcp')
    expect(checkedEndpoint('http://127.0.0.1:8080/mcp')).toBe('http://127.0.0.1:8080/mcp')
    expect(checkedEndpoint('https://192.168.1.20/mcp')).toBe('https://192.168.1.20/mcp')
    expect(checkedEndpoint('https://x.1a/mcp')).toBe('https://x.1a/mcp')
    for (const value of [undefined, null, 42, '', 'http://mcp.tresso.example/mcp', 'http://localhost.evil.example/mcp', 'https://kim:pw@mcp.tresso.example/mcp', 'https://mcp.tresso.example/mcp?x=1', 'https://mcp.tresso.example/mcp#x', "https://mcp.tresso.example/mcp'", 'https://mcp.tresso.example/$(id)', 'https://mcp.tresso.example/m cp', 'https://mcp.tréssö.example/mcp', 'https://mcp.例え.example/mcp', 'javascript:alert(1)', 'http://[::1]:8080/mcp', 'https://mcp.tresso.example/mcp"', "https://mcp.tresso.example/it's", 'https://MCP.tresso.example/mcp', 'https://mcp.tresso.example:65536/mcp', 'https://mcp.tresso.example:0/mcp', 'https://mcp.tresso.example/a/../mcp', 'https://mcp.tresso.example/./mcp', 'https://mcp.tresso.example/%PATH%', 'https://mcp.tresso.example/~kim/mcp', 'https://mcp.tresso.example:443/mcp', 'http://localhost:80/mcp', 'https://1.2.3/mcp', 'https://0x7f.1/mcp', 'https://01.2.3.4/mcp', 'https://a.123/mcp', 'https://1.2.3.256/mcp', 'https://mcp.0x10/mcp', 'https://xn--mcp.tresso.example/mcp', 'https://mcp.xn--trsso-fsa.example/mcp', 'https://mcp..tresso.example/mcp', 'https://mcp.tresso.example./mcp']) {
      expect({ value, checked: checkedEndpoint(value) }).toEqual({ value, checked: null })
    }
    const none = installs(null)
    expect(none.find((item) => item.id === 'claude-code')!.command).toBeUndefined()
    expect(none.find((item) => item.id === 'cursor')!.url).toBeUndefined()
  })

  it('marks an app with two letters', () => {
    expect(appInitials('Claude')).toBe('CL')
    expect(appInitials('ChatGPT')).toBe('CG')
    expect(appInitials('Cursor')).toBe('CU')
    expect(appInitials('Calendar bridge')).toBe('CB')
    expect(appInitials('  ')).toBe('')
  })
})
