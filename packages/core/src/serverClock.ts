/**
 * The server's clock as a client can tell it from the `Date` header of its answers: the device's clock may be off by
 * minutes, and a send time the server keeps (the undo window) must be counted on the server's. Until an answer was
 * noted it is the device's clock. The header has whole seconds, so the estimate is that close.
 */
export class ServerClock {
  private offset = 0

  /** Notes the `Date` header of an answer that arrived at `receivedAt` (the device's epoch ms); others are ignored. */
  note(date: string | null, receivedAt: number = Date.now()): void {
    const server = date === null ? Number.NaN : Date.parse(date)
    if (Number.isFinite(server)) {
      this.offset = server - receivedAt
    }
  }

  /** The time on the server's clock now, in epoch ms. */
  now(): number {
    return Date.now() + this.offset
  }
}
