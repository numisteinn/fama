# Sleep timer on the web

The Sleep timer pauses playback after a countdown or at the end of a Chapter. A countdown lowers the volume over its last three seconds. The player restores full volume after the pause or when the listener cancels the timer.

## Sub-features

- `sleep-web-countdown` sets 15, 30, 45, or 60 minutes and shows the time left.
- `sleep-web-extend` adds five minutes to the countdown.
- `sleep-web-cancel` turns the timer off and restores full volume.
- `sleep-web-chapter` pauses at the start of the next Chapter. At the last Chapter, it pauses at the end of the Episode.

## How to get to it (user POV)

Play an Episode. Select the moon button, **Sleep timer**, in the player bar. Select a preset or **End of chapter**. Open the same menu for **Off** or **+5 min**.

## Driving it with preview tools and agent-device

Use the web baseline in [the feature map](./README.md). Add `harbour-days.epub` through the Add bar and wait for both Chapters to be Ready.

1. Play **Harbour Days**. Select the button named `Sleep timer, off`. Check that the four presets and **End of chapter** appear. Pick **15 min**. Capture the badge at `15:00` or just below it, then capture a smaller value while audio plays.
2. Open the timer again. Pick **+5 min** and check that the badge adds five minutes. Open the menu once more and select **Off**. Check that playback continues and the badge disappears.
3. Set **End of chapter** while **Morning** plays. Check for `Ch. end`. When **Morning** ends, check that the player shows **Evening**, the **Play** button and `Sleep timer, off`. Check that the position holds at the boundary. Select **Play** and check that the position moves into **Evening**.
4. Set **End of chapter** during **Evening**. Check that the player pauses at the total Episode duration and the timer turns off.
5. For countdown expiry, use a Ready Episode with more than 15 minutes of audio. Set **15 min** and leave playback running. Listen for the drop in volume during the last three seconds. Check that playback pauses and the moon button returns to `Sleep timer, off`. Select **Play** and check for full volume. In a second run, select **Off** or **Pause** during the fade and check that playback has full volume when it plays again.

Save the menu, active badge, and paused player snapshots under `$EVIDENCE/sleep-timer-web/`. Save the Episode API read and the chapter audio response evidence there too.

## Gotchas

- A countdown uses a wall-clock deadline. The badge updates while audio plays. If the deadline passes while paused, the timer clears on resume.
- Loading another Episode turns off the timer. The web player holds the timer for the current Episode in this tab.
- The audio element is detached from the DOM. Use the **Position** control and the **Play** or **Pause** button to confirm playback state.
