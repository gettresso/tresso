import { retryAfterMs } from '@tresso/core'

/** A failed API request, with what the API said about it (RFC 9457 problem details and validation violations). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Messages per field path, e.g. "imap.host". */
    readonly violations: Record<string, string> = {},
    /** How long the server asked to wait before trying again (Retry-After), in ms; null when it did not say. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static async fromResponse(path: string, response: Response): Promise<ApiError> {
    let detail: string | null = null
    const violations: Record<string, string> = {}
    try {
      const body = (await response.json()) as { detail?: unknown; title?: unknown; violations?: unknown }
      detail = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : null
      if (Array.isArray(body.violations)) {
        for (const violation of body.violations as { propertyPath?: unknown; message?: unknown }[]) {
          if (typeof violation.propertyPath === 'string' && typeof violation.message === 'string' && !(violation.propertyPath in violations)) {
            violations[violation.propertyPath] = violation.message
          }
        }
      }
    } catch {
      // Not JSON: keep the generic message.
    }

    return new ApiError(response.status, detail ?? `Request to ${path} failed (${response.status}).`, violations, retryAfterMs(response.headers.get('Retry-After')))
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
