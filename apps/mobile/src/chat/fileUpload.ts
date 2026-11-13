import { cacheDirectory, createUploadTask, deleteAsync, FileSystemUploadType, getInfoAsync } from 'expo-file-system/legacy'
import type { ChatUploadOptions } from '@tresso/core'

/**
 * Files on the phone for WhatsApp replies, through expo-file-system (which ships with Expo, so no new native module):
 * an upload that reads the file from its URI and streams it (never into JavaScript), with its progress and a cancel; the
 * size of a picked file; and removing the copy the picker made in the cache.
 */

/** Sends a file as the raw body of a PUT; the server's answer as a Response. `send` of AuthSession.upload. */
export function uploadByUri(uri: string, options: ChatUploadOptions = {}): (url: string, token: string) => Promise<Response> {
  return async (url, token) => {
    if (options.signal?.aborted) {
      throw new DOMException('The upload was cancelled.', 'AbortError')
    }
    const task = createUploadTask(
      url,
      uri,
      {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
      },
      (progress) => options.onProgress?.(progress.totalBytesSent, progress.totalBytesExpectedToSend),
    )
    const cancel = () => void task.cancelAsync()
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await task.uploadAsync()
      if (result === undefined || result === null || options.signal?.aborted) {
        throw new DOMException('The upload was cancelled.', 'AbortError')
      }
      return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers })
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  }
}

/** The size of a file on the phone in bytes; null when it cannot be told. */
export async function fileSizeOf(uri: string): Promise<number | null> {
  try {
    const info = await getInfoAsync(uri)
    return info.exists && typeof info.size === 'number' ? info.size : null
  } catch {
    return null
  }
}

/** Removes a copy the picker made in the app's cache; a file elsewhere (the user's own) is never touched. */
export async function removeCachedCopy(uri: string): Promise<void> {
  if (cacheDirectory !== null && uri.startsWith(cacheDirectory)) {
    await deleteAsync(uri, { idempotent: true }).catch(() => undefined)
  }
}
