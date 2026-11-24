# Empty Library

The web and iPhone show folded Ribbon + Fan Pan when the Library has no Episodes.

## Sub-features

- `empty-library-art` shows the sleeping Pan image in the empty Library.

## How to get to it (user POV)

Connect the app to a server with an empty Library. On iPhone, open the Library tab.

## Driving it with preview tools and agent-device

- Use a fresh local verification instance. Check that `fama-verify api GET /api/episodes` returns an empty list.
- Open the web Library. Check that the 160 px sleeping Pan image loads from `/pan-sleeping.png`.
- On iPhone, open the Library tab. Check that folded Pan appears above “Nothing to listen to yet.” Save a screenshot with `agent-device`.

## Gotchas

- Wait until the first Library request finishes. The web app does not show Pan while it loads.
- An iPhone with no server also shows Pan. Check the empty Library after the app connects.
