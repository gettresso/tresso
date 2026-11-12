# The WhatsApp bridge Tresso starts

The desktop app (macOS) reads and answers WhatsApp chats through the Go bridge of whatsapp-mcp, in Tresso's fork
[gettresso/whatsapp-mcp](https://github.com/gettresso/whatsapp-mcp), which the user builds once on their own Mac (the
connect dialog links there). Tresso starts that binary itself (`apps/desktop/src-tauri/src/whatsapp.rs`), reads its SQLite store read only and calls its REST
API. The bridge's REST API has no check of its own: anything on the Mac reaches 127.0.0.1, another program as well
as a web page in a browser (a `no-cors` POST with a JSON body is enough), and upstream listens on every network
interface. So Tresso only uses a bridge that keeps the contract below. A bridge that answers without the token (upstream
[lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) as published, or a bridge started in a terminal) is
stopped and reported as `unprotected`: the connect dialog and Settings then say in plain words that any app or web page
on the Mac could send messages through it, and to download the fork, build its bridge again and choose that folder.

## Contract

1. **Environment.** Tresso starts the binary `<folder>/whatsapp-bridge/whatsapp-bridge` without a shell or
   arguments, in `<folder>/whatsapp-bridge`, with only `HOME`, `PATH`, `TMPDIR` and:
   - `WHATSAPP_BRIDGE_PORT`: the port to listen on (Tresso asks for 8741).
   - `WHATSAPP_BRIDGE_TOKEN`: 64 hex characters, new for every process Tresso starts. Tresso keeps it in memory only,
     never writes it to a file or a log, and sends it to no other process; the bridge must not write it either.
2. **Bind.** The REST API listens on `127.0.0.1:<WHATSAPP_BRIDGE_PORT>` only, and prints
   `Starting REST API server on 127.0.0.1:<port>...` before it does.
3. **Host.** A request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` gets `403` first, with or
   without a token. A web page that makes its own name resolve to 127.0.0.1 (DNS rebinding) sends its own name.
4. **Token.** When `WHATSAPP_BRIDGE_TOKEN` is set, every request must carry it in the header `X-Bridge-Token`
   (compared in constant time). A request without it, or with another value, gets `401` before anything else is
   looked at. When the variable is set but empty, the bridge does not listen at all.
5. **Content type.** Every request must have `Content-Type: application/json` (parameters such as `charset` are fine);
   anything else gets `415`. A page in a browser cannot send that header, or the token, without a CORS preflight the
   bridge never answers.
6. **The probe.** `POST /api/send` with the body `{}` answers `401` without the token, and `400 Recipient is required`
   with it. Tresso uses a bridge only when it sees both. Before it starts a bridge, Tresso asks the port without a
   token only: whatever already listens there never gets one.
7. **Downloads.** `downloadMedia` keeps only the last part of a stored file name (`filepath.Base`) and refuses `.`,
   `..` and `/`: a document's name comes from whoever sent it, and the bridge writes the file to
   `store/<chat>/<name>`. A chat JID with `/`, `\` or `..` is refused. Tresso also refuses to ask for a stored name
   that is not one plain name, so an unpatched bridge never gets such a request from Tresso.

## Installing and building

```sh
git clone https://github.com/gettresso/whatsapp-mcp.git
cd whatsapp-mcp/whatsapp-bridge && go build -o whatsapp-bridge .
```

Then choose the `whatsapp-mcp` folder in Tresso (Settings, Accounts, Connect WhatsApp). The fork keeps every point of
the contract above: it binds to 127.0.0.1, reads `WHATSAPP_BRIDGE_PORT` (default 8741), checks the host, the token and
the content type, and keeps a stored file name to one plain name; it also builds against a current whatsmeow. Tresso
does not run `go` itself (a GUI app's `PATH` usually lacks it); when the folder has no built bridge, the dialog shows
the command above. A bridge built from upstream, or from the fork before its token check, is refused as
`unprotected` until it is built again from the fork.

The Python MCP server of whatsapp-mcp (`whatsapp.py`) calls the same API: with a token set it needs to send the
header as well, or be pointed at a bridge started without `WHATSAPP_BRIDGE_TOKEN`. A bridge Tresso starts always has
one, so an AI app's MCP server cannot use that bridge until it sends the token.
