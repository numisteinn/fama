import AVFoundation

/// Plays one short sample clip, so the user can choose a voice by ear.
/// Independent of the episode player: no Now Playing, no remote commands, no timeline.
/// The same clip resumes; another clip replaces it.
final class SamplePlayer {
  private var player: AVPlayer?
  private var url: String = ""
  private var endObserver: NSObjectProtocol?
  private var statusObservation: NSKeyValueObservation?
  private let emit: ([String: Any]) -> Void

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
  }

  func play(_ clip: URL) {
    let absolute = clip.absoluteString
    if player != nil, absolute == url {
      activateSession()
      player?.play()
      publish(playing: true)
      return
    }
    releasePlayer()
    let item = AVPlayerItem(url: clip)
    item.audioTimePitchAlgorithm = .timeDomain
    player = AVPlayer(playerItem: item)
    url = absolute
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      guard let self, self.url == absolute else { return }
      // The next Play of the clip starts from the top.
      self.player?.seek(to: .zero)
      self.publish(playing: false)
    }
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      DispatchQueue.main.async {
        guard let self else { return }
        self.emit(["url": self.url, "playing": false, "error": item.error?.localizedDescription ?? "Playback failed"])
      }
    }
    activateSession()
    player?.play()
    publish(playing: true)
  }

  func pause() {
    player?.pause()
    publish(playing: false)
  }

  func stop() {
    let last = url
    releasePlayer()
    if !last.isEmpty { emit(["url": last, "playing": false]) }
  }

  private func releasePlayer() {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    statusObservation?.invalidate()
    statusObservation = nil
    player?.pause()
    player = nil
  }

  private func activateSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
      try session.setActive(true)
    } catch {
      emit(["url": url, "playing": false, "error": error.localizedDescription])
    }
  }

  private func publish(playing: Bool) {
    emit(["url": url, "playing": playing])
  }
}
