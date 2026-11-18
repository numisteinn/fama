// Makes the audio the mock API serves: spoken chapters (macOS `say`) encoded to AAC .m4a, plus a cover.
// Run: node scripts/make-fixtures.ts
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const out = join(import.meta.dirname, "fixtures")

const chapters: Record<string, string> = {
  "rest-0": `On rest between sets. Chapter one. Rest is part of the work. When you put the bar down, the set is not over.
    Your muscles are clearing what they spent, and your nervous system is getting ready to ask for the same effort again.
    For heavy strength work, two to three minutes is a fair place to start. For lighter sets, sixty to ninety seconds is enough.
    Use the time. Breathe slowly through your nose. Walk a little. Do not reach for your phone and lose ten minutes.
    The clock is part of the program, the same as the weight on the bar.`,
  "rest-1": `Chapter two. Reading your own recovery. Some days the rest you planned is too short.
    If the next set feels like a different exercise, wait another minute. If your form breaks on the first rep, the rest was too short.
    Write down what you did, so next week you can see the pattern, not guess at it.
    Strength comes from many good sets over many weeks. A good set needs a body that is ready for it.`,
  "run-0": `The long run. Chapter one. Start slower than you think you should.
    The first ten minutes decide how the last ten feel. Keep your breathing easy enough that you could speak a full sentence.`,
  "run-1": `Chapter two. In the middle of a long run, the mind starts to bargain.
    Pick a landmark ahead, and run to it. Then pick the next one. The distance is made of small pieces.`,
  "run-2": `Chapter three. The last part of the run is where the training happens.
    Hold your form. Short steps, tall posture, relaxed hands. Finish, then walk for five minutes before you stop.`,
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const [name, text] of Object.entries(chapters)) {
  const aiff = join(out, `${name}.aiff`)
  execFileSync("say", ["-o", aiff, text.replace(/\s+/g, " ")])
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-c:a", "aac", "-b:a", "64k", "-ac", "1", join(out, `${name}.m4a`)])
  rmSync(aiff)
  console.log(`${name}.m4a`)
}

execFileSync("ffmpeg", [
  "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1d2b1f:s=600x600", "-frames:v", "1",
  "-vf", "drawbox=x=120:y=380:w=360:h=40:color=0xD8F26A:t=fill,drawbox=x=120:y=300:w=240:h=40:color=0xD8F26A@0.6:t=fill",
  join(out, "cover-rest.png"),
])
console.log("cover-rest.png")
