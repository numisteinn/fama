# Web reader

Open Text in the player to read the Episode. The current Segment follows the audio.

## Sub-features

- Read Chapters in order. New Chapters appear as the Worker finishes them.
- Select text to copy it. Click a Segment or focus it and press Enter to play from its start.
- Scroll away to stop following. Click Current sentence or scroll back to resume.

## How to get to it (user POV)

Attach `harbour-year.epub`, click Add, then Play Harbour Year. Click the book button (Text) in the player. Click it again to return to the Library.

## Driving it with preview tools and agent-device

1. Start the local verification stack. Use a fresh web tab. Before clicking Play, capture the detached audio element by wrapping `HTMLMediaElement.prototype.play` to save its receiver and call the original method.
2. Open Text. Read the Episode from `GET /api/episodes`. Fetch the current Chapter's `timingUrl`.
3. In one browser evaluation, read the audio element's `currentTime * 1000` and the id and text of `#reader [aria-current=true]`. Run the contract's `segmentIndexAt(segments, ms)` and compare both the index and the text. Repeat for three different Segments.
4. Read the start time of a Segment in Summer. Click its text. Check the Chapter audio URL and the seek offset. Add the duration of Spring to that offset and compare it with the Position slider's `aria-valuenow` at the seek.
5. Scroll away with the wheel. The next Segment must leave the scroll position alone. Click Current sentence and check that the mark comes back above the player.
6. Save a wide screenshot and a 390 px screenshot. Check that the text fits and the player controls remain visible. Close the tab and stop the verification stack.

## Gotchas

- A Chapter with a null timing URL has no text. If all Chapters have null timing URLs, the player has no Text button.
- The first Segment can start after zero. The reader has no mark before that start.
- A hidden preview can throttle animation frames. Measure the audio clock and the time between frames when checking a late mark.
