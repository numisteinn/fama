# Phone connect

The iPhone app connects to a server in two ways: the QR code of `pnpm fama setup`, or the server URL and API token typed in Settings. The QR code holds `fama://connect?server=<url>&token=<client token>`, which the iOS Camera opens in the app. The app checks the token with `GET /api/me` on that server, and only then saves the server, token and user and shows that user's library. To switch from another server or user, it asks once. A bad link or a refused token shows the reason and keeps the current connection.

## Sub-features

- `connect-manual` saves a typed server URL and token. The status reads `Connected` after `GET /api/me` answers.
- `connect-link` connects from a `fama://connect` link and opens the Library with that user's episodes.
- `connect-ask` asks `Switch account?` (server URL and user id in the message) before it leaves another server or user. `Cancel` keeps the current connection.
- `connect-refused` shows `Could not connect` with the reason (`The API token was rejected.`, `The server must use https.`), and the current connection stays.
- `connect-no-trace` keeps the link out of navigation: the screen behind the alert does not change, and no route named `connect` exists.

## How to get to it (user POV)

- Scan the QR code that `pnpm fama setup` prints with the iPhone Camera, and tap the Fama banner.
- Or: tab `Settings`, type `Server URL` and `API token`, tap `Save`.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`, with `dev.fama.app` already running (see Gotchas). Record the `Server URL` from Settings before the first link.
- One Ready episode on 8788, so the library has a row to show. Adding it through the API is fine here, because the feature under test is the connect path.

- **Link with another server connected.** With Settings showing a server other than 8788, run `$AD open dev.fama.app "fama://connect?server=http%3A%2F%2Flocalhost%3A8788&token=dev-api-token"`. An alert `Switch account?` shows `http://localhost:8788` and `dev-user`. Settings behind it does not change.
- **Cancel.** `$AD alert dismiss`. `Server URL` keeps its old value.
- **Switch.** Open the same link again, then `$AD press 'label="Switch"'` (`alert accept` does not find this button). The app opens the Library, which lists the 8788 episodes. Settings shows `http://localhost:8788` and `Connected`.
- **Wrong token.** `$AD open dev.fama.app "fama://connect?server=http%3A%2F%2Flocalhost%3A8788&token=wrong-token"`. Alert `Could not connect`, text `The API token was rejected.`. After `$AD alert accept`, Settings still shows `http://localhost:8788` and `Connected`, and the library is the same.
- **Not https.** Open `fama://connect?server=http%3A%2F%2Ffama.example.com&token=dev-api-token`. Alert `Could not connect`, text `The server must use https.`. No request goes to that host.
- **Proof.** Save `$AD screenshot` before the link, with each alert, and after, to `$EVIDENCE/phone-connect/`. The parse and decision rules are proven by `packages/contracts/src/connect.test.ts` and `apps/mobile/src/lib/pairing.test.ts`.
- **Cleanup.** Put `Server URL` back to the recorded value and save.

## Gotchas

- Cold start with a link is not drivable on the debug dev client: the dev launcher takes the launch URL and shows its server list, and the link never reaches the app. Open links only while the app runs. The cold-start path (`redirectSystemPath` with `initial: true`) is proven only by `pairing.test.ts`, not on a device.
- The API token field is secure, so the old token cannot be read back. After the run the token is `dev-api-token`.
- `agent-device` logs the link, token included, in its session state. Use only the dev token in links.
