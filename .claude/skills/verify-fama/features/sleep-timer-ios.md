# iPhone sleep timer

The iPhone player can pause after a 15, 30, 45 or 60 minute countdown, or at the end of the current chapter. The toolbar shows the live countdown and the next chapter starts at its beginning when the chapter timer fires.

## Sub-features

- Open the sleep timer menu from the moon button in the player tools row.
- Choose a countdown preset, `End of chapter`, `+5 minutes`, or `Turn off`.
- Confirm the active countdown label updates once per second.
- Confirm the player pauses at expiry and resumes at the start of the next chapter.

## How to get to it (user POV)

1. Add or open a ready episode on the iPhone.
2. Open the episode player.
3. Tap the moon button beside Playback speed, AirPlay, and Download.
4. Choose `15 minutes` and confirm the button shows the countdown.
5. Open the menu again to test `+5 minutes` and `Turn off`.
6. Choose `End of chapter` on an episode with at least two chapters.
7. Let playback cross the chapter boundary. Confirm playback pauses and the next chapter is selected at `0:00`.

## Driving it with preview tools and agent-device

Use the iPhone setup in `../SKILL.md`: start a fresh local run, start Metro, open `dev.fama.app` with `agent-device`, and point the app at `http://localhost:8788`.

```sh
.claude/skills/verify-fama/scripts/fama-verify up
.claude/skills/verify-fama/scripts/fama-verify metro
```

On the simulator:

1. Add `.claude/skills/verify-fama/fixtures/harbour-days.epub` through the Add screen.
2. Wait until the episode is Ready, open it, and capture the player before tapping the moon button.
3. Tap the button labelled `Sleep timer Off`, choose `15 minutes`, and capture the active countdown.
4. Open it again, choose `Turn off`, and capture the inactive moon button.
5. Select `End of chapter` on the two-chapter episode. Capture the pause and the next chapter at its start after the boundary.

Save before and after screenshots under `$EVIDENCE/sleep-timer-ios/`. Clean up with `fama-verify down` and restore the simulator server URL.

## Gotchas

- Use a two-chapter episode for the boundary check. A final chapter has no next chapter to seek.
- Do not use `simctl`, `idb`, or a deployed server for UI actions.
- The feature uses wall-clock time. Pausing manually does not extend a countdown.
