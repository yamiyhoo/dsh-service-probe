# dsh-service-probe

A DSH plugin that answers one question without guessing: **what can a plugin that lives inside this
Host actually do?**

It was written to settle a specific question about the DeepSeek Harness *desktop* application. That
host is described in its own source as booting "without a listening socket" — it carries the API over
byte pipes — and its shipped patch layer disables the `webserver` row *after* any user layer, so no
profile edit can turn it back on. The open question is whether a plugin loaded there can open its own
loopback port instead. This probe reports that, plus which services exist.

## What it writes

JSONL, one line per phase:

| file | note |
| --- | --- |
| `%USERPROFILE%\.dsh\logs\dsh-service-probe.jsonl` | the main copy |
| `%TEMP%\dsh-service-probe.jsonl` | a second copy, in case the log directory is wiped |
| stdout | the same line, which the Host usually captures into its own log |

Three phases:

- `load` — pid, `execPath`, `argv`, cwd, node/electron versions, `DSH_HOME`
- `surface` — which of 24 service names resolve, with type, constructor and method names; and the
  cordis surface (`inject`/`effect`/`on`/`get`/`provider`) it was handed
- `listener` — whether `http.createServer().listen(0, '127.0.0.1')` works, the port it got, and
  whether a real request to itself came back

Reading it:

```
Get-Content "$env:USERPROFILE\.dsh\logs\dsh-service-probe.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object phase -eq 'listener'
```

## What it deliberately never does

- **Never throws.** `apply` runs while the Host boots; an exception there is not a failed probe, it is
  a person's application not starting. Every step is wrapped, and failures are recorded.
- **Never holds the port.** Port 0 (OS-assigned), one real round trip, then close and `unref`.
- **Never depends on anything.** No dependencies, no install scripts, no build step. The file the
  Host loads is the file in this package (`index.cjs`).

## Install

Into a normal profile (the CLI refuses the `desktop` profile by design — that one takes the in-app
plugin market):

```
dsh plugin --profile <profile> add github:<owner>/dsh-service-probe
```

**Do not install with `link:`.** The desktop host rejects a profile bundle whose real path resolves
outside the profile or runtime directory, and then the application does not boot. A copy-style
install (from a git URL or a registry) lands inside `profiles/<name>/node_modules` and is fine.

The bundle patch declares the row `required: false`: if the package cannot resolve, the Host boots
without it. So an empty log means *the plugin did not load*, not that the probe found nothing.

## Uninstall

```
dsh plugin --profile <profile> remove dsh-service-probe     # normal profiles
```

On the desktop application, remove it from the plugin market, then delete the two log files if you
want them gone.

## Licence

MIT.
