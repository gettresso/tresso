import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from './realtime'
import type { RealtimeAccess } from './types'

/** A hub response whose event stream the test writes to. */
function stream(): { response: Response; send(text: string): void; sendBytes(bytes: Uint8Array): void; close(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
  const encoder = new TextEncoder()

  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    sendBytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
  }
}

function access(token: string, expiresInMs = 3_600_000): RealtimeAccess {
  return {
    hubUrl: 'https://app.example/.well-known/mercure',
    topic: 'urn:tresso:user:u1:changes',
    token,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await tick()
  }
  expect(condition()).toBe(true)
}

describe('RealtimeClient', () => {
  let client: RealtimeClient | null = null
  afterEach(async () => {
    await client?.stop()
    client = null
    vi.useRealTimers()
  })

  it('subscribes with the token as bearer and reports cursors', async () => {
    const hub = stream()
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => hub.response)
    const cursors: number[] = []
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess: async () => access('t1'), onCursor: (c) => cursors.push(c), onConnected, fetch })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    hub.send(':\n\nevent: changes\ndata: {"cursor":7}\n\n')
    hub.send('event: other\ndata: {"cursor":99}\n\nevent: changes\ndata: not json\n\nevent: changes\ndata: {"cursor":-1}\n\n')
    hub.send('event: changes\ndata: {"cursor":8}\n\n')
    await until(() => cursors.length === 2)

    expect(cursors).toEqual([7, 8])
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://app.example/.well-known/mercure?match=urn%3Atresso%3Auser%3Au1%3Achanges')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t1')
  })

  it('retries with a fresh token after a refusal', async () => {
    const hub = stream()
    const fetch = vi
      .fn<(url: URL | RequestInfo, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(hub.response)
    const fetchAccess = vi.fn().mockResolvedValueOnce(access('old')).mockResolvedValue(access('new'))
    const onError = vi.fn()
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, onConnected, onError, fetch, retryDelays: [1] })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('401') }))
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer new')
  })

  it('reconnects when the hub closes the stream', async () => {
    const first = stream()
    const second = stream()
    const fetch = vi
      .fn<(url: URL | RequestInfo, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValue(second.response)
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess: async () => access('t'), onCursor: () => {}, onConnected, fetch, retryDelays: [1] })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    first.close()

    await until(() => onConnected.mock.calls.length === 2)
  })

  it('renews the token before it expires without reporting an error', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const hub = stream()
      init?.signal?.addEventListener('abort', () => hub.response.body?.cancel().catch(() => {}))
      return hub.response
    })
    const fetchAccess = vi.fn().mockResolvedValueOnce(access('short', 120_000)).mockResolvedValue(access('long'))
    const onError = vi.fn()
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, onConnected, onError, fetch, idleTimeout: 3_600_000 })

    client.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(onConnected).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(onConnected).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    expect(fetchAccess).toHaveBeenCalledTimes(2)
  })

  it('does not ask for tokens in a loop when the device clock runs ahead of the server', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const hub = stream()
      init?.signal?.addEventListener('abort', () => hub.response.body?.cancel().catch(() => {}))
      return hub.response
    })
    // An hour ahead: every token looks expired already.
    const fetchAccess = vi.fn(async () => access('t', -3_600_000))
    const onError = vi.fn()
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, onError, fetch })

    client.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchAccess).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchAccess).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('waits before asking again when a token is renewed before the hub even answered', async () => {
    vi.useFakeTimers()
    // The hub never answers; the request ends only when it is aborted.
    const fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    )
    const fetchAccess = vi.fn(async () => access('t', -3_600_000))
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, fetch, retryDelays: [10_000], idleTimeout: 3_600_000 })

    client.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchAccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchAccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchAccess).toHaveBeenCalledTimes(2)
  })

  it('takes a stream that went silent for dead and connects again, while heartbeats keep it open', async () => {
    vi.useFakeTimers()
    const hubs: ReturnType<typeof stream>[] = []
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const hub = stream()
      hubs.push(hub)
      init?.signal?.addEventListener('abort', () => hub.response.body?.cancel().catch(() => {}))
      return hub.response
    })
    const fetchAccess = vi.fn(async () => access('t'))
    const onError = vi.fn()
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, onConnected, onError, fetch, retryDelays: [1_000] })

    client.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(onConnected).toHaveBeenCalledTimes(1)
    // A heartbeat comment every 40 s keeps it open.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(40_000)
      hubs[0]!.send(':\n')
    }
    expect(onError).not.toHaveBeenCalled()

    // Then nothing: the connection died without being closed.
    await vi.advanceTimersByTimeAsync(100_000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'The realtime hub went quiet.' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchAccess).toHaveBeenCalledTimes(2)
    expect(onConnected).toHaveBeenCalledTimes(2)
  })

  it('stops listening on stop', async () => {
    const hub = stream()
    const onConnected = vi.fn()
    const fetch = vi.fn(async () => hub.response)
    client = new RealtimeClient({ fetchAccess: async () => access('t'), onCursor: () => {}, onConnected, fetch })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    await client.stop()
    client = null

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts a token request under way when stopped, so a sign-out does not wait for one that hangs', async () => {
    let signal: AbortSignal | null = null
    const onError = vi.fn()
    const hanging = new RealtimeClient({
      // A token request that never answers, until it is aborted, as fetch does.
      fetchAccess: (aborted) =>
        new Promise<RealtimeAccess>((_resolve, reject) => {
          signal = aborted
          aborted.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
      onCursor: () => {},
      onError,
    })

    hanging.start()
    await until(() => signal !== null)
    const outcome = await Promise.race([hanging.stop().then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))])

    expect(outcome).toBe('stopped')
    expect(signal!.aborted).toBe(true)
    // A stop is no error.
    expect(onError).not.toHaveBeenCalled()
  })

  it('stops at once when stopped just before waiting for the next attempt', async () => {
    let stopping: Promise<void> | null = null
    const failing = new RealtimeClient({
      fetchAccess: async () => {
        throw new Error('offline')
      },
      onCursor: () => {},
      retryDelays: [60_000],
      // Runs after the client checked whether it was stopped and before it starts to wait.
      onError: () => {
        stopping ??= failing.stop()
      },
    })

    failing.start()
    await until(() => stopping !== null)
    const outcome = await Promise.race([stopping!.then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))])

    expect(outcome).toBe('stopped')
  })

  it('reads characters split across chunks of the stream', async () => {
    const hub = stream()
    const cursors: number[] = []
    const onConnected = vi.fn()
    client = new RealtimeClient({ fetchAccess: async () => access('t1'), onCursor: (c) => cursors.push(c), onConnected, fetch: async () => hub.response })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    // "é" is two bytes in UTF-8; the comment line splits it over two chunks before the event follows.
    const bytes = new TextEncoder().encode(': caf\u00e9\n\nevent: changes\ndata: {"cursor":3}\n\n')
    const split = bytes.indexOf(0xc3) + 1
    hub.sendBytes(bytes.slice(0, split))
    hub.sendBytes(bytes.slice(split))
    await until(() => cursors.length === 1)

    expect(cursors).toEqual([3])
  })

  it('runs one connection when started again right after a stop', async () => {
    const hubs = [stream(), stream()]
    let connections = 0
    const onConnected = vi.fn()
    client = new RealtimeClient({
      fetchAccess: async () => access('t1'),
      onCursor: () => {},
      onConnected,
      fetch: async () => hubs[connections++]!.response,
      retryDelays: [0],
    })

    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    const stopping = client.stop()
    client.start()
    await stopping
    await until(() => onConnected.mock.calls.length === 2)
    for (let i = 0; i < 20; i++) {
      await tick()
    }

    expect(connections).toBe(2)
  })

  it('leaves no second connection when stopped and started while the first was still asking for a token', async () => {
    const hubs = [stream(), stream()]
    let connections = 0
    let grant: (value: RealtimeAccess) => void = () => {}
    let asks = 0
    const onConnected = vi.fn()
    client = new RealtimeClient({
      fetchAccess: () => {
        asks++
        return asks === 1 ? new Promise<RealtimeAccess>((resolve) => (grant = resolve)) : Promise.resolve(access('t2'))
      },
      onCursor: () => {},
      onConnected,
      fetch: async () => hubs[connections++]!.response,
    })

    client.start()
    await until(() => asks === 1)
    const stopping = client.stop()
    client.start()
    await until(() => onConnected.mock.calls.length === 1)
    grant(access('t1'))
    await stopping
    for (let i = 0; i < 20; i++) {
      await tick()
    }
    expect(connections).toBe(1)

    const finished = await Promise.race([client.stop().then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('still running'), 500))])
    expect(finished).toBe('stopped')
  })

  it("takes the silence limit from the hub's heartbeat the server tells, and none when the hub sends none", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const hub = stream()
      init?.signal?.addEventListener('abort', () => hub.response.body?.cancel().catch(() => {}))
      return hub.response
    })
    const onError = vi.fn()
    const slow = vi.fn(async () => ({ ...access('t'), heartbeat: 120 }))
    client = new RealtimeClient({ fetchAccess: slow, onCursor: () => {}, onError, fetch, retryDelays: [1_000] })

    client.start()
    // A hub with a 120 s heartbeat may be quiet for 299 s without being dead.
    await vi.advanceTimersByTimeAsync(299_000)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'The realtime hub went quiet.' }))
    await client.stop()

    const silent = vi.fn(async () => ({ ...access('t'), heartbeat: 0 }))
    const quiet = vi.fn()
    client = new RealtimeClient({ fetchAccess: silent, onCursor: () => {}, onError: quiet, fetch })
    client.start()
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(quiet).not.toHaveBeenCalled()
  })

  it("reads the token's expiry against the server's clock", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const hub = stream()
      init?.signal?.addEventListener('abort', () => hub.response.body?.cancel().catch(() => {}))
      return hub.response
    })
    // The device is an hour ahead: the token expires at the device's now, an hour from now on the server's clock.
    const fetchAccess = vi.fn(async () => access('t', 0))
    client = new RealtimeClient({ fetchAccess, onCursor: () => {}, fetch, now: () => Date.now() - 3_600_000, idleTimeout: 7_200_000 })

    client.start()
    await vi.advanceTimersByTimeAsync(3_000_000)
    expect(fetchAccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchAccess).toHaveBeenCalledTimes(2)
  })
})
