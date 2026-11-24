# Read along on iPhone

Open Read along in the player to read the Episode. The reader marks the Segment that plays and keeps it in sight. A tap on the text plays from that Segment.

## Sub-features

- Read chapter headings and paragraphs. A new chapter appears when its Timing file arrives.
- Skip or scrub to move the mark. Scroll by hand to stop automatic scrolling. Choose Current sentence to follow again.
- Download an Episode to keep its audio and text on the device.

## How to get to it (user POV)

Add Harbour Year from Files. Open the Episode in Library. Choose Read along. Play, pause, skip, or tap a sentence. Choose Close reader to return to the artwork.

## Driving it with preview tools and agent-device

1. Use the local stack and the iPhone instructions in the skill. Build and install the native dev client, start Metro from this checkout and open the app on that Metro port. Record the Server URL before changing it.
2. Follow the Add a file recipe with `harbour-year.epub`. Wait for a playable chapter. Choose Harbour Year, then Read along. Check that new chapters appear as the Job runs.
3. Pause and take a screenshot. Read the Position. Repeat after two skips. Fetch each chapter's Timing file from its media URL. Subtract the durations of earlier chapters from the Episode position. Call the contract's `segmentIndexAt(segments, positionMs)` and compare its text to the mark. For a whole-second display, check both ends of that second or choose a position farther from a Segment boundary.
4. Resume. Swipe up in the text until a later chapter is visible. Save two screenshots several seconds apart. The text should stay in place while the elapsed time changes. Pause and tap a sentence in the later chapter. Verify the chapter, elapsed time, mark, and Pause button.
5. Choose Download and wait for Downloaded. Stop the local API, relaunch, open the cached Episode and repeat the tap. Restore the Server URL and stop the test processes.

## Gotchas

- An Episode with no Timing files has no Read along button.
- Use the device command from the T3 Device panel. A dev client with the old native module still reports its position every half second. Rebuild to measure mark updates.
- The Swift player reports Episode seconds. The Timing file gives chapter milliseconds.
