//! Adding Tresso to Cursor from Settings, Apps, AI assistants: the shell builds Cursor's MCP install link itself and
//! opens it. The page gives only the server's MCP endpoint, which is checked here as the web client checks it
//! (apps/web/src/components/apps/assistantInstalls.ts): https (http only on this computer), no user or password, no
//! query or fragment, plain ASCII without spaces, brackets or characters a shell or a link would read as more than an address.
//! The page can never make the shell open any other link: the opener's own scope allows no `cursor://` link at all.
//!
//! The link is the form Cursor documents (cursor.com/docs/mcp/install-links):
//! `cursor://anysphere.cursor-deeplink/mcp/install?name=tresso&config=<base64 of {"url": endpoint}>`.

/// The name Tresso has in Cursor's list of servers.
pub const SERVER_NAME: &str = "tresso";

const LOOPBACK: [&str; 2] = ["localhost", "127.0.0.1"];

/// The endpoint when it is a plain address an assistant can be pointed at, else why not.
pub fn checked_endpoint(endpoint: &str) -> Result<&str, String> {
  let refused = || Err("This is not an MCP endpoint Tresso can open Cursor with.".to_string());
  if endpoint.is_empty() || endpoint.len() > 2048 {
    return refused();
  }
  // Only what an MCP endpoint needs: not `%` (cmd.exe expands %PATH%), not `~` (a shell expands it).
  if !endpoint.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".:/-".contains(&byte)) {
    return refused();
  }
  let (scheme, rest) = match endpoint.split_once("://") {
    Some(parts) => parts,
    None => return refused(),
  };
  // The host ends at its port or path (an IPv6 address in brackets is refused with the other characters above).
  let authority = rest.split('/').next().unwrap_or("");
  let (host, port) = match authority.split_once(':') {
    Some((host, port)) => (host, Some(port)),
    None => (authority, None),
  };
  // Written as a browser writes it, so what the web client checked is what is opened: a lower-case host, a port from
  // 1 to 65535, and no `.` or `..` segment in the path.
  if host.is_empty() || host.contains('%') || host.bytes().any(|byte| byte.is_ascii_uppercase()) || !plain_host(host) {
    return refused();
  }
  // A browser leaves out the scheme's own port (443 for https, 80 for http), so an address that names it is not one
  // the web client accepts either.
  if let Some(port) = port {
    let default = if scheme == "https" { 443 } else { 80 };
    match port.parse::<u32>() {
      Ok(number) if (1..=65535).contains(&number) && !port.starts_with('0') && number != default => {}
      _ => return refused(),
    }
  }
  if rest.split('/').skip(1).any(|segment| segment == "." || segment == "..") {
    return refused();
  }
  let loopback = LOOPBACK.contains(&host);
  match scheme {
    "https" => Ok(endpoint),
    "http" if loopback => Ok(endpoint),
    _ => refused(),
  }
}

/// A host the web client's URL parser leaves as it is (and the page accepts):
/// - no empty label and no punycode label (`xn--`), which the parser would check or rewrite;
/// - a host whose last label is a number (all digits, or `0x` and hex digits: the parser reads it as an IPv4 address)
///   only as four decimal octets from 0 to 255 without leading zeros, the one form the parser writes back unchanged.
fn plain_host(host: &str) -> bool {
  let labels: Vec<&str> = host.split('.').collect();
  if labels.iter().any(|label| label.is_empty() || label.starts_with("xn--")) {
    return false;
  }
  let last = labels[labels.len() - 1];
  let numeric = last.bytes().all(|byte| byte.is_ascii_digit())
    || (last.len() >= 2 && last.starts_with("0x") && last[2..].bytes().all(|byte| byte.is_ascii_hexdigit()));
  if !numeric {
    return true;
  }
  labels.len() == 4
    && labels.iter().all(|octet| {
      octet.bytes().all(|byte| byte.is_ascii_digit())
        && (octet.len() == 1 || !octet.starts_with('0'))
        && octet.parse::<u16>().is_ok_and(|number| number <= 255)
    })
}

/// Cursor's install link for this endpoint.
pub fn cursor_install_link(endpoint: &str) -> Result<String, String> {
  let endpoint = checked_endpoint(endpoint)?;
  // The endpoint holds no quote or backslash (checked above), so it is a JSON string as it is.
  let config = base64(format!("{{\"url\":\"{endpoint}\"}}").as_bytes());
  Ok(format!(
    "cursor://anysphere.cursor-deeplink/mcp/install?name={SERVER_NAME}&config={}",
    config.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D")
  ))
}

/// Standard base64 with padding, as `btoa` writes it.
fn base64(bytes: &[u8]) -> String {
  const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
    let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
    for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
      if i <= chunk.len() {
        out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
      } else {
        out.push('=');
      }
    }
  }
  out
}

/// Opens Cursor's install prompt for this server.
#[tauri::command]
pub fn open_cursor_install(endpoint: String) -> Result<(), String> {
  let link = cursor_install_link(&endpoint)?;
  tauri_plugin_opener::open_url(&link, None::<&str>).map_err(|error| format!("Opening Cursor failed: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builds_the_documented_link_for_a_checked_endpoint() {
    let link = cursor_install_link("https://mcp.tresso.example/mcp").unwrap();
    assert_eq!(
      link,
      "cursor://anysphere.cursor-deeplink/mcp/install?name=tresso&config=eyJ1cmwiOiJodHRwczovL21jcC50cmVzc28uZXhhbXBsZS9tY3AifQ%3D%3D"
    );
    assert!(cursor_install_link("http://localhost:8080/mcp").is_ok());
    assert!(cursor_install_link("http://127.0.0.1:8080/mcp").is_ok());
    assert!(cursor_install_link("https://mcp.tresso.example:8443/mcp").is_ok());
    assert!(cursor_install_link("https://192.168.1.20/mcp").is_ok());
    assert!(cursor_install_link("https://mcp-1.tresso.example/mcp").is_ok());
    assert!(cursor_install_link("https://x.1a/mcp").is_ok());
  }

  #[test]
  fn refuses_anything_but_a_plain_address() {
    for endpoint in [
      "",
      "http://mcp.tresso.example/mcp",
      "javascript:alert(1)",
      "cursor://anysphere.cursor-deeplink/mcp/install?name=x",
      "https://user:pass@mcp.tresso.example/mcp",
      "https://mcp.tresso.example/mcp?x=1",
      "https://mcp.tresso.example/mcp#x",
      "https://mcp.tresso.example/mcp'; rm -rf ~",
      "https://mcp.tresso.example/m cp",
      "https://mcp.tréssö.example/mcp",
      "https://mcp.tresso.example/mcp\"}",
      "https://",
      "http://localhost.evil.example/mcp",
      "http://[::1]:8080/mcp",
      "https://MCP.tresso.example/mcp",
      "https://mcp.tresso.example:0/mcp",
      "https://mcp.tresso.example:65536/mcp",
      "https://mcp.tresso.example:/mcp",
      "https://mcp.tresso.example:80a/mcp",
      "https://mcp.tresso.example/a/../mcp",
      "https://mcp.tresso.example/./mcp",
      "https://mcp.tresso.example/%PATH%",
      "https://mcp.tresso.example/~kim/mcp",
      "https://mcp.tresso.example:443/mcp",
      "http://localhost:80/mcp",
      "https://1.2.3/mcp",
      "https://0x7f.1/mcp",
      "https://01.2.3.4/mcp",
      "https://a.123/mcp",
      "https://1.2.3.256/mcp",
      "https://1.2.3.4.5/mcp",
      "https://mcp.0x10/mcp",
      "https://xn--mcp.tresso.example/mcp",
      "https://mcp.xn--trsso-fsa.example/mcp",
      "https://mcp..tresso.example/mcp",
      "https://mcp.tresso.example./mcp",
      "ftp://mcp.tresso.example/mcp",
    ] {
      assert!(cursor_install_link(endpoint).is_err(), "{endpoint}");
    }
  }

  #[test]
  fn writes_base64_as_btoa_does() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
  }
}
