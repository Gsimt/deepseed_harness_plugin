# Sampling Temperature

Adds a per-session sampling-temperature control to the Harness Web composer. The
value set in the composer applies to every model request this session sends until
it is changed or reset, without changing the conversation history.

## What the user sees

A compact pill in the composer tool row, immediately before the submit action:

- `自动` / `Auto` when no override is set (the provider's own default applies).
- `0.7` (or whichever value) once a temperature is chosen.

Clicking the pill opens a small popover with a 0–2 slider, the preset values
0.2 / 0.5 / 0.7 / 1, and *Reset to default*. The chosen value is stored by the
Host per session and shown again the next time the session is opened in the same
Host process.

## Host surfaces

| Surface | Purpose |
|---|---|
| `agent/request` waterfall | Replaces the frozen call configuration of a session that has an override, adding `temperature`. Sessions without an override are untouched. |
| `/temperature [0-2\|default]` command | The same operation without the UI, available in the composer's slash-command menu. Running it with no argument reports the current value. |
| `GET /plugin/temperature-control/state?sessionId=…` | Reads one session's override, plus the last call this plugin actually rewrote. |
| `POST /plugin/temperature-control/state` | Writes `{ sessionId, temperature }`; `temperature: null` clears the override. |

The host half holds overrides in memory only: the value is a UI preference, not
model-visible content, so it is intentionally not written to the session log.

## Limits

- Overrides are per host process and are not persisted across a restart.
- A provider that rejects the `temperature` parameter itself is not compensated for.
- The value applies to the session's next admitted request; a request already in
  flight is unaffected.
