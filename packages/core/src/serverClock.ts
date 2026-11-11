/** Answers that took longer than this to come back say too little about when the server wrote its Date header. */
const MAX_ROUND_TRIP_MS = 2_000
/**
 * A difference smaller than this is taken for none: the header has whole seconds, so a device clock that is right
 * would otherwise be corrected by up to a second the wrong way, and the undo window cut short for everyone.
 */
const AGREE_WITHIN_MS = 2_000

/**
 * The server's clock as a client can tell it from the `Date` header of its answers: the device's clock may be off by
 * minutes, and a send time the server keeps (the undo window) must be counted on the server's. Until an answer was
 * noted, and while the two clocks agree within two seconds, it is the device's clock.
 */
export class ServerClock {
  private offset = 0

  /**
   * Notes the `Date` header of an answer to a request sent at `sentAt` that arrived at `receivedAt` (the device's epoch
   * ms). The server wrote the header somewhere in between, so it is set against the middle of the round trip, and the
   * header's whole second is taken at its middle too. An answer without a readable date, or one that took too long
   * (a slow network, a device that slept), is ignored.
   */
  note(date: string | null, sentAt: number, receivedAt: number = Date.now()): void {
    const server = date === null ? Number.NaN : Date.parse(date)
    const roundTrip = receivedAt - sentAt
    if (!Number.isFinite(server) || roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) {
      return
    }
    const offset = server + 500 - (sentAt + roundTrip / 2)
    this.offset = Math.abs(offset) < AGREE_WITHIN_MS ? 0 : offset
  }

  /** The time on the server's clock now, in epoch ms. */
  now(): number {
    return Date.now() + this.offset
  }
}
