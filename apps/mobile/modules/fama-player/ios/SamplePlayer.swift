import AVFoundation

/// Plays one short sample clip, so the user can choose a voice by ear.
/// Independent of the episode player: no Now Playing, no remote commands, no timeline.
/// The same clip resumes; another clip replaces it.
final class SamplePlayer {
  private var player: AVPlayer?
  private var url: String = ""
  private var endObserver: NSObjectProtocol?
  private var failedEndObserver: NSObjectProtocol?
  private var statusObservation: NSKeyValueObservation?
  private var timeControlObservation: NSKeyValueObservation?
  private let emit: ([String: Any]) -> Void

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
  }

  deinit {
    releasePlayer()
  }

  func play(_ clip: URL, rawUrl: String) {
    if let existing = player, rawUrl == url {
      guard activateSession(for: rawUrl) else { return }
      existing.play()
      publish(url: rawUrl, playing: existing.timeControlStatus != .paused)
      return
    }
    releasePlayer()
    url = ""
    let item = AVPlayerItem(url: clip)
    item.audioTimePitchAlgorithm = .timeDomain
    let next = AVPlayer(playerItem: item)
    player = next
    url = rawUrl
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      guard let self, self.url == rawUrl else { return }
      // The next Play of the clip starts from the top.
      self.player?.seek(to: .zero)
      self.publish(url: rawUrl, playing: false)
    }
    failedEndObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
    ) { [weak self] note in
      guard let self, self.url == rawUrl else { return }
      let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      self.fail(url: rawUrl, message: err?.localizedDescription ?? "Playback failed")
    }
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      let message = item.error?.localizedDescription ?? "Playback failed"
      DispatchQueue.main.async {
        guard let self, self.url == rawUrl else { return }
        self.fail(url: rawUrl, message: message)
      }
    }
    timeControlObservation = next.observe(\.timeControlStatus, options: [.new]) { [weak self] observed, _ in
      let isPlaying = observed.timeControlStatus != .paused
      DispatchQueue.main.async {
        guard let self, self.url == rawUrl, self.player === observed else { return }
        self.publish(url: rawUrl, playing: isPlaying)
      }
    }
    guard activateSession(for: rawUrl) else {
      releasePlayer()
      url = ""
      return
    }
    next.play()
  }

  func pause() {
    guard let player, !url.isEmpty else { return }
    player.pause()
    publish(url: url, playing: false)
  }

  func stop(deactivateSession: Bool = false) {
    let last = url
    releasePlayer()
    url = ""
    if deactivateSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    if !last.isEmpty { emit(["url": last, "playing": false]) }
  }

  private func fail(url failedUrl: String, message: String) {
    releasePlayer()
    url = ""
    emit(["url": failedUrl, "playing": false, "error": message])
  }

  private func releasePlayer() {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = nil
    if let failedEndObserver { NotificationCenter.default.removeObserver(failedEndObserver) }
    failedEndObserver = nil
    statusObservation?.invalidate()
    statusObservation = nil
    timeControlObservation?.invalidate()
    timeControlObservation = nil
    player?.pause()
    player = nil
  }

  private func activateSession(for activeUrl: String) -> Bool {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
      try session.setActive(true)
      return true
    } catch {
      emit(["url": activeUrl, "playing": false, "error": error.localizedDescription])
      return false
    }
  }

  private func publish(url activeUrl: String, playing: Bool) {
    emit(["url": activeUrl, "playing": playing])
  }
}
