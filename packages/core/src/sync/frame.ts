/**
 * The document a client puts in a sandboxed frame to show a message body from GET /api/v1/messages/{id}/body. The
 * API already sanitized the HTML; this Content-Security-Policy is the second, independent layer: no scripts, no
 * plugins, no forms, and images only from the API (where attachments live) or, once the reader allowed it, from the
 * internet. The frame itself must be sandboxed without allow-scripts.
 */
export function mailFrameDocument(html: string, options: { apiOrigin: string; allowRemoteContent: boolean }): string {
  const remote = options.allowRemoteContent ? ' https: http:' : ''
  const policy = [
    "default-src 'none'",
    `img-src ${options.apiOrigin} data:${remote}`,
    "style-src 'unsafe-inline'",
    `font-src data:${remote}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')

  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">` +
    '<meta name="color-scheme" content="light">' +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    '<style>html{background:#fff;color:#16181D}body{margin:0;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>' +
    `</head><body>${html}</body></html>`
  )
}

/**
 * The document for previewing signature HTML while it is edited, before the API sanitized it. Nothing in it runs and
 * images load only the way the saved signature allows them (https and data); the frame must be sandboxed without
 * allow-scripts. `background` shows how the signature reads in a light or a dark mail client. `transparent` drops
 * that background so the signature sits on the screen around the frame, as in the compose window.
 */
export function signatureFrameDocument(html: string, options: { background: 'light' | 'dark'; transparent?: boolean }): string {
  const policy = ["default-src 'none'", 'img-src https: data:', "style-src 'unsafe-inline'", "form-action 'none'", "base-uri 'none'"].join('; ')
  const ink = options.background === 'dark' ? 'color:#F3F4F6' : 'color:#16181D'
  const ground = options.transparent === true ? 'background:transparent' : options.background === 'dark' ? 'background:#1B1D22' : 'background:#fff'
  const colors = `${ground};${ink}`

  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">` +
    `<meta name="color-scheme" content="${options.background}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    `<style>html{${colors}}body{margin:0;font:13px/1.5 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` +
    `</head><body>${html}</body></html>`
  )
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
