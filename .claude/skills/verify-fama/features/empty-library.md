# Empty Library

The web and iPhone show folded Ribbon + Fan Pan when the Library has no Episodes.

## Sub-features

- `empty-library-art` shows the sleeping Pan image in the empty Library.
- `empty-library-unreachable` shows Pan with the reason and a button on the iPhone when the app cannot load the Library: `Open Settings` when the server never named the token's user, `Try again` when the first list fails.

## How to get to it (user POV)

Connect the app to a server with an empty Library. On iPhone, open the Library tab.

## Driving it with preview tools and agent-device

- Use a fresh local verification instance. Check that `fama-verify api GET /api/episodes` returns an empty list.
- Open the web Library. Check that the 160 px sleeping Pan image loads from `/pan-sleeping.png`.
- On iPhone, open the Library tab. Check that folded Pan appears above “Nothing to listen to yet.” Save a screenshot with `agent-device`.

## Gotchas

- Wait until the first Library request finishes. The web app does not show Pan while it loads.
- An iPhone with no server also shows Pan. Check the empty Library after the app connects.
- To get an iPhone with a connection and no known user, change `Server URL` to an address with no server and tap `Save`. Save clears the stored user. The Library must then show Pan and `Could not reach the server.`, never an empty screen. Put the `Server URL` back after.
