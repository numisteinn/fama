import { Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { AddBar } from "~/components/AddBar"
import { LibraryList } from "~/components/LibraryList"
import { PlayerBar } from "~/components/PlayerBar"
import { SettingsDialog } from "~/components/SettingsDialog"
import { Button } from "~/components/ui/button"
import { useLibrary } from "~/library"
import { PlayerProvider, usePlayer } from "~/player"

export function App() {
  const library = useLibrary()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const unauthorized = library.error?.status === 401

  useEffect(() => {
    if (unauthorized) setSettingsOpen(true)
  }, [unauthorized])

  return (
    <PlayerProvider episodes={library.episodes}>
      <Page>
        <header className="flex h-14 items-center justify-between">
          <span className="text-[17px] font-semibold tracking-tight">Fama</span>
          <Button size="icon-sm" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings />
          </Button>
        </header>
        <AddBar onAdded={library.upsert} />
        <section className="mt-6">
          <LibraryList library={library} />
        </section>
      </Page>
      <PlayerBar />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </PlayerProvider>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  const { episode } = usePlayer()
  return (
    <main
      className="mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)] sm:px-6"
      style={{ paddingBottom: episode ? "11rem" : "3rem" }}
    >
      {children}
    </main>
  )
}
