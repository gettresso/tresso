# The WhatsApp bridge Tresso starts

The desktop app (macOS) reads and answers WhatsApp chats through the Go bridge of
[whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), which the user builds once on their own Mac. Tresso starts
that binary itself (`apps/desktop/src-tauri/src/whatsapp.rs`), reads its SQLite store read only and calls its REST
API. The bridge's REST API has no check of its own: anything on the Mac reaches 127.0.0.1, another program as well
as a web page in a browser (a `no-cors` POST with a JSON body is enough), and upstream listens on every network
interface. So Tresso only uses a bridge that keeps the contract below. A bridge that answers without the token (upstream
as published) is stopped and reported as `unprotected`.

## Contract

1. **Environment.** Tresso starts the binary `<folder>/whatsapp-bridge/whatsapp-bridge` without a shell or
   arguments, in `<folder>/whatsapp-bridge`, with only `HOME`, `PATH`, `TMPDIR` and:
   - `WHATSAPP_BRIDGE_PORT`: the port to listen on (Tresso asks for 8741).
   - `WHATSAPP_BRIDGE_TOKEN`: 64 hex characters, new every time Tresso starts. Tresso keeps it in memory only and never
     writes it to a file or a log; the bridge must not either.
2. **Bind.** The REST API listens on `127.0.0.1:<WHATSAPP_BRIDGE_PORT>` only, and prints
   `Starting REST API server on 127.0.0.1:<port>...` before it does.
3. **Token.** When `WHATSAPP_BRIDGE_TOKEN` is set, every request must carry it in the header `X-Bridge-Token`
   (compared in constant time). A request without it, or with another value, gets `401` before anything else is
   looked at. When the variable is set but empty, the bridge does not listen at all.
4. **Content type.** Every request must have `Content-Type: application/json` (parameters such as `charset` are fine);
   anything else gets `415`. A page in a browser cannot send that header, or the token, without a CORS preflight the
   bridge never answers.
5. **The probe.** `POST /api/send` with the body `{}` answers `401` without the token, and `400 Recipient is required`
   with it. Tresso uses a bridge only when it sees both.
6. **Downloads.** `downloadMedia` keeps only the last part of a stored file name (`filepath.Base`) and refuses `.`,
   `..` and `/`: a document's name comes from whoever sent it, and the bridge writes the file to
   `store/<chat>/<name>`. A chat JID with `/`, `\` or `..` is refused. Tresso also refuses to ask for a stored name
   that is not one plain name, so an unpatched bridge never gets such a request from Tresso.

## The patch

[`whatsapp-bridge-token.patch`](whatsapp-bridge-token.patch) implements points 3, 4 and 6 in `whatsapp-bridge/main.go`.
It is made against the bridge as it is in the owner's checkout, which already has points 1 and 2 (it binds to
127.0.0.1, reads `WHATSAPP_BRIDGE_PORT`, default 8741) and a current whatsmeow; upstream `7d6a06d` has neither, so the
patch does not apply there as it is. Apply it from the root of the whatsapp-mcp checkout with
`git apply docs/whatsapp-bridge-token.patch` (copied there), then `go build -o whatsapp-bridge .` in `whatsapp-bridge`.
It builds and passes `gofmt` against that tree. Where the patched bridge is published (a fork, or pull requests
upstream) is the owner's decision (decision D2 of the WhatsApp plan).

The Python MCP server of whatsapp-mcp (`whatsapp.py`) calls the same API: with a token set it needs to send the
header as well, or be pointed at a bridge started without `WHATSAPP_BRIDGE_TOKEN`. A bridge Tresso starts always has
one, so an AI app's MCP server cannot use that bridge until it sends the token.
