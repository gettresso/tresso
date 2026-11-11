<?php

declare(strict_types=1);

/*
 * An IMAP and SMTP stand-in for connection checks: listens on two free ports, prints "<imap port> <smtp port>", and
 * answers one IMAP connection and then one SMTP connection, both without TLS.
 *   argv[1]  the password the IMAP server accepts (any username)
 *   argv[2]  the password the SMTP server accepts (any username)
 *   argv[3]  optional: "tls" for IMAP over TLS from the first byte, "starttls" for IMAP that offers STARTTLS
 *   argv[4]  with argv[3]: a PEM file with the server's certificate and key
 */
$arguments = $_SERVER['argv'] ?? [];
$imapPassword = is_array($arguments) && is_string($arguments[1] ?? null) ? $arguments[1] : '';
$smtpPassword = is_array($arguments) && is_string($arguments[2] ?? null) ? $arguments[2] : '';
$security = is_array($arguments) && is_string($arguments[3] ?? null) ? $arguments[3] : 'none';
$certificate = is_array($arguments) && is_string($arguments[4] ?? null) ? $arguments[4] : '';
$secure = static function (mixed $client) use ($certificate): bool {
    if (!is_resource($client)) {
        return false;
    }
    stream_context_set_option($client, 'ssl', 'local_cert', $certificate);
    stream_context_set_option($client, 'ssl', 'verify_peer', false);

    return true === @stream_socket_enable_crypto($client, true, \STREAM_CRYPTO_METHOD_TLS_SERVER);
};

$imap = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
$smtp = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
if (false === $imap || false === $smtp) {
    fwrite(\STDERR, $errorMessage ?? 'Cannot listen.');
    exit(1);
}
$port = static fn (mixed $server): string => is_resource($server) ? substr((string) strrchr((string) stream_socket_get_name($server, false), ':'), 1) : '';
echo $port($imap), ' ', $port($smtp), "\n";

$line = static function (mixed $client): string {
    $read = is_resource($client) ? fgets($client) : false;

    return false === $read ? '' : rtrim($read, "\r\n");
};
$unquote = static fn (string $value): string => stripcslashes(trim($value, '"'));

$client = stream_socket_accept($imap, 10);
if (false === $client) {
    exit(1);
}
if ('tls' === $security && !$secure($client)) {
    exit(0);
}
fwrite($client, "* OK IMAP4rev1 ready\r\n");
$signedIn = false;
while (true) {
    $command = $line($client);
    if ('' === $command) {
        break;
    }
    [$tag, $verb] = explode(' ', $command, 3) + [1 => '', 2 => ''];
    $rest = explode(' ', $command, 3)[2] ?? '';
    switch (strtoupper($verb)) {
        case 'LOGIN':
            preg_match('/^("(?:[^"\\\\]|\\\\.)*"|\S+) ("(?:[^"\\\\]|\\\\.)*"|\S+)$/', $rest, $parts);
            $signedIn = ($parts[2] ?? null) !== null && $unquote($parts[2]) === $imapPassword;
            fwrite($client, $signedIn ? "$tag OK LOGIN completed\r\n" : "$tag NO [AUTHENTICATIONFAILED] Invalid credentials\r\n");
            break;
        case 'LIST':
            fwrite($client, "* LIST (\\HasNoChildren) \"/\" INBOX\r\n* LIST (\\HasNoChildren \\Sent) \"/\" Sent\r\n* LIST (\\HasNoChildren) \"/\" Archive\r\n$tag OK LIST completed\r\n");
            break;
        case 'STARTTLS':
            fwrite($client, "$tag OK Begin TLS\r\n");
            if (!$secure($client)) {
                exit(0);
            }
            break;
        case 'LOGOUT':
            fwrite($client, "* BYE\r\n$tag OK LOGOUT completed\r\n");
            break 2;
        default:
            fwrite($client, "$tag BAD Unknown command\r\n");
    }
}
fclose($client);
if (!$signedIn) {
    exit(0);
}

$client = stream_socket_accept($smtp, 10);
if (false === $client) {
    exit(1);
}
fwrite($client, "220 localhost ESMTP ready\r\n");
while (true) {
    $command = $line($client);
    if ('' === $command) {
        break;
    }
    $verb = strtoupper(explode(' ', $command)[0]);
    if ('EHLO' === $verb) {
        fwrite($client, "250-localhost\r\n250-PIPELINING\r\n250 AUTH PLAIN LOGIN\r\n");
    } elseif ('AUTH' === $verb) {
        $credentials = explode("\0", (string) base64_decode(explode(' ', $command)[2] ?? '', true));
        fwrite($client, ($credentials[2] ?? null) === $smtpPassword ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid\r\n");
    } elseif ('QUIT' === $verb) {
        fwrite($client, "221 Bye\r\n");
        break;
    } else {
        fwrite($client, "502 Unknown command\r\n");
    }
}
fclose($client);
