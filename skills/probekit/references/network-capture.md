# Network capture with mitmproxy

The goal is to see what the app actually contacts at runtime, without
intercepting the user's whole machine and without defeating the app's own
protections.

## Scope the capture to the target only

mitmproxy's local mode redirects only the processes you name. Use the target's
executable name plus any helper/provider process names (find them in the bundle,
or with `pgrep -fl` while the app runs):

```bash
mkdir -p ~/rea-captures/<name>-<date>
mitmdump \
  --mode 'local:<app-process>,<helper1>,<helper2>' \
  --set hardump=~/rea-captures/<name>-<date>/capture.har \
  --set flow_detail=1
```

Traffic from every process outside that list passes through untouched, so the
user can keep working. **Do not** add shared system processes like
`com.apple.WebKit.Networking` unless you specifically want in-app web traffic and
the user has closed other WebKit apps (Safari, Mail). Otherwise you'll capture
unrelated traffic.

The first run of `mitmdump` generates the CA under `~/.mitmproxy/`.

## Trust the CA (needs the user's password → hand them the command)

Prefer the user login keychain (no `sudo`, easy to remove):

```bash
security add-trusted-cert -r trustRoot -p ssl \
  -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem
```

A GUI dialog asks for the password. If a target needs the System keychain, that
requires `sudo` and a real terminal, so give the user this command:

```bash
sudo security add-trusted-cert -d -p ssl \
  -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem
```

macOS may also ask the user to approve mitmproxy's network system extension once.

## When the app pins certificates

Many well-built apps (anything using rustls+webpki-roots, or explicit pinning)
embed their own trust anchors and reject the proxy CA. The log or the app will
show something like:

```
Client TLS handshake failed … does not trust the proxy's certificate (unknown ca)
invalid peer certificate: UnknownIssuer
```

**Report this as a positive finding**: the app resists a man-in-the-middle, even
one with keychain access. Don't fight it. Let those hosts through so the app
works, and still learn *which* hosts it talks to from DNS/SNI:

```bash
mitmdump --mode 'local:<app>,<helpers>' \
  --ignore-hosts '^(.+\.)?(googleapis\.com|google\.com|<first-party>\.org):443$' \
  --set hardump=~/rea-captures/<name>-<date>/capture.har --set flow_detail=1
```

Stripping pinning (binary patch, Frida injection, or SSLKEYLOGFILE if the
binary supports it, which most don't) means analyzing a *modified* app and
usually breaking its signature. Offer it only if the user asks and understands
the cost, and never do it by default. The host list plus the static analysis
usually answers the question anyway.

## Drive the session

With the capture running, ask the user to use the app: launch it, log in or add
an account, let it sync, open any update or plugin/catalog features, then leave
it idle for a couple of minutes. Stop the capture cleanly (`SIGINT`, not kill -9,
so the HAR gets written):

```bash
kill -INT "$(pgrep -x mitmdump)"
```

## Read the capture

- List the hosts (this works even for pinned connections with no readable body):
  ```bash
  grep -oE 'DNS QUERY \(A+\) [a-zA-Z0-9._-]+' <log> | awk '{print $NF}' | sort -u
  ```
- Flag anything that is **not** first-party or an expected cloud API. That short
  list is the core of the network finding.
- For readable (non-pinned) flows, inspect method/URL/host and **redact tokens**
  (`sed -E 's/(code|token|access_token|refresh_token|state)=[^& ]+/\1=<REDACTED>/g'`).
- For a structured pass, REA can parse the HAR offline
  (`inspect_web_network_capture`, HAR format on macOS).

## Cleanup (give these to the user at the end)

```bash
security delete-certificate -c mitmproxy ~/Library/Keychains/login.keychain-db
rm -rf ~/rea-captures/<name>-<date>
```

The capture and the installed CA hold real secrets. Don't leave them lying
around, and never send a raw capture to any external service.
