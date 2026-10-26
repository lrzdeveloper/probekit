# Network capture with mitmproxy

Goal: see what the app actually contacts at runtime, without intercepting the
user's whole machine and without defeating the app's own protections.

## Scope to the target, nothing else

mitmproxy's **local mode** redirects only named processes. Use the target's
executable name plus any helper/provider process names (find them in the bundle,
or with `pgrep -fl` while the app runs):

```bash
mkdir -p ~/rea-captures/<name>-<date>
mitmdump \
  --mode 'local:<app-process>,<helper1>,<helper2>' \
  --set hardump=~/rea-captures/<name>-<date>/capture.har \
  --set flow_detail=1
```

Everything not in that process list passes through untouched — the user can keep
working. **Do not** add shared system processes like
`com.apple.WebKit.Networking` unless you specifically want in-app web traffic and
the user has closed other WebKit apps (Safari, Mail), or you'll capture unrelated
traffic.

First run of `mitmdump` generates the CA under `~/.mitmproxy/`.

## Trust the CA (needs the user's password → hand them the command)

Prefer the **user login keychain** (no `sudo`, easy to remove):

```bash
security add-trusted-cert -r trustRoot -p ssl \
  -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem
```

A GUI dialog asks for the password. If a target needs the System keychain, that
one needs `sudo` and a real terminal — give the user:

```bash
sudo security add-trusted-cert -d -p ssl \
  -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem
```

macOS may also ask the user to approve mitmproxy's network system extension once.

## When the app pins certificates

Many well-built apps (anything using rustls+webpki-roots, or explicit pinning)
embed their own trust anchors and reject the proxy CA. You'll see, in the log or
from the app:

```
Client TLS handshake failed … does not trust the proxy's certificate (unknown ca)
invalid peer certificate: UnknownIssuer
```

**Report this as a positive finding** — the app resists a man-in-the-middle even
one with keychain access. Don't fight it. Let those hosts through so the app
works, and still learn *which* hosts it talks to from DNS/SNI:

```bash
mitmdump --mode 'local:<app>,<helpers>' \
  --ignore-hosts '^(.+\.)?(googleapis\.com|google\.com|<first-party>\.org):443$' \
  --set hardump=~/rea-captures/<name>-<date>/capture.har --set flow_detail=1
```

Stripping pinning (binary patch, Frida injection, SSLKEYLOGFILE if the binary
supports it — most don't) means analyzing a *modified* app and usually breaking
its signature. Offer it only if the user asks and understands the cost; never
default to it. The host list plus the static analysis usually answers the
question anyway.

## Drive the session

With the capture running, have the user exercise the app: launch, log in / add an
account, let it sync, open any update or plugin/catalog features, then leave it
idle a couple of minutes. Then stop the capture cleanly (`SIGINT`, not kill -9,
so the HAR flushes):

```bash
kill -INT "$(pgrep -x mitmdump)"
```

## Read the capture

- Enumerate hosts (works even for pinned, body-less connections):
  ```bash
  grep -oE 'DNS QUERY \(A+\) [a-zA-Z0-9._-]+' <log> | awk '{print $NF}' | sort -u
  ```
- Flag anything **not** first-party or an expected cloud API. That short list is
  the heart of the network finding.
- For readable (non-pinned) flows, inspect method/URL/host; **redact tokens**
  (`sed -E 's/(code|token|access_token|refresh_token|state)=[^& ]+/\1=<REDACTED>/g'`).
- REA can parse the HAR offline (`inspect_web_network_capture`, HAR format on
  macOS) for a structured pass.

## Cleanup (give these to the user at the end)

```bash
security delete-certificate -c mitmproxy ~/Library/Keychains/login.keychain-db
rm -rf ~/rea-captures/<name>-<date>
```

The capture and the installed CA hold real secrets — don't leave them lying
around, and never send a raw capture to any external service.
