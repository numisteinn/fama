import AVFoundation
import MediaPlayer
import UIKit

struct Track {
  let url: URL
  let title: String
  let duration: Double
}

struct EpisodeInfo {
  let id: String
  let title: String
  let artist: String?
  let artworkUrl: URL?
}

/// Plays the chapters of one episode as one timeline.
/// Positions in and out are episode seconds; chapter boundaries stay inside.
final class EpisodePlayer: NSObject {
  private let player = AVQueuePlayer()
  private let emit: ([String: Any]) -> Void

  private var episode: EpisodeInfo?
  private var tracks: [Track] = []
  private var starts: [Double] = []
  private var itemIndex: [ObjectIdentifier: Int] = [:]
  private var rate: Float = 1
  private var wantsPlay = false
  private var resumeAfterInterruption = false
  private var lastError: String?
  /// Where a running seek will land. Repeated skips build on it, not on the old time.
  private var seekTarget: Double?
  private var artwork: MPMediaItemArtwork?
  private var timeObserver: Any?
  private var observations: [NSKeyValueObservation] = []
  private var itemStatusObservation: NSKeyValueObservation?

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
    player.actionAtItemEnd = .advance
    player.automaticallyWaitsToMinimizeStalling = true
    observePlayer()
    observeSession()
    setUpRemoteCommands()
  }

  // MARK: Commands

  func load(_ info: EpisodeInfo, tracks newTracks: [Track], position: Double, rate newRate: Float, autoplay: Bool) {
    episode = info
    rate = newRate
    player.defaultRate = newRate
    setTracks(newTracks)
    lastError = nil
    seekTarget = nil
    artwork = nil
    loadArtwork(for: info)
    let target = locate(position)
    let landing = (starts[safe: target.index] ?? 0) + target.offset
    seekTarget = landing
    rebuildQueue(from: target.index, offset: target.offset, landing: landing)
    if autoplay { play() } else { wantsPlay = false; player.pause() }
    publish()
  }

  /// Chapters grow while the job runs. Appends new chapters to the queue and
  /// resumes when playback ran out of chapters while the listener wanted to play.
  func updateTracks(_ newTracks: [Track]) {
    guard episode != nil, newTracks.count >= tracks.count else { return }
    let oldCount = tracks.count
    let wasWaiting = player.currentItem == nil && wantsPlay
    let kept = tracks
    setTracks(newTracks.enumerated().map { index, track in
      index < kept.count ? Track(url: kept[index].url, title: track.title, duration: track.duration) : track
    })
    guard newTracks.count > oldCount else { publish(); return }
    if player.currentItem == nil {
      if wasWaiting {
        rebuildQueue(from: oldCount, offset: 0)
        play()
      }
    } else {
      for index in oldCount..<tracks.count { enqueue(index) }
    }
    publish()
  }

  func play() {
    guard episode != nil else { return }
    activateSession()
    wantsPlay = true
    if player.currentItem == nil {
      // Finished: play again from the start.
      if !tracks.isEmpty && isAtEnd { rebuildQueue(from: 0, offset: 0) }
    }
    player.defaultRate = rate
    player.play()
    publish()
  }

  func pause() {
    wantsPlay = false
    player.pause()
    publish()
  }

  func seek(to position: Double) {
    guard !tracks.isEmpty else { return }
    let target = locate(position)
    let landing = starts[target.index] + target.offset
    seekTarget = landing
    if target.index == currentIndex, let item = player.currentItem {
      item.seek(to: cmTime(target.offset), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
        self?.seekLanded(landing)
      }
    } else {
      rebuildQueue(from: target.index, offset: target.offset, landing: landing)
      if wantsPlay { player.play() }
    }
    publish()
  }

  private func seekLanded(_ landing: Double) {
    if seekTarget == landing { seekTarget = nil }
    publish()
  }

  func skip(by delta: Double) {
    seek(to: max(0, min(totalDuration, position + delta)))
  }

  func setRate(_ newRate: Float) {
    rate = newRate
    player.defaultRate = newRate
    if wantsPlay && player.rate != 0 { player.rate = newRate }
    publish()
  }

  func unload() {
    wantsPlay = false
    seekTarget = nil
    player.pause()
    player.removeAllItems()
    itemIndex = [:]
    episode = nil
    tracks = []
    starts = []
    artwork = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    publish()
  }

  // MARK: Timeline

  private var currentIndex: Int {
    if let item = player.currentItem, let index = itemIndex[ObjectIdentifier(item)] { return index }
    return max(0, tracks.count - 1)
  }

  private var isAtEnd: Bool { player.currentItem == nil && !tracks.isEmpty }

  private var totalDuration: Double { (starts.last ?? 0) + (tracks.last?.duration ?? 0) }

  var position: Double {
    if let seekTarget { return seekTarget }
    if isAtEnd { return totalDuration }
    guard let item = player.currentItem else { return 0 }
    let seconds = item.currentTime().seconds
    return (starts[safe: currentIndex] ?? 0) + (seconds.isFinite ? seconds : 0)
  }

  private func setTracks(_ newTracks: [Track]) {
    tracks = newTracks
    var sum = 0.0
    starts = newTracks.map { track in
      defer { sum += track.duration }
      return sum
    }
  }

  private func locate(_ position: Double) -> (index: Int, offset: Double) {
    guard !tracks.isEmpty else { return (0, 0) }
    for index in tracks.indices.reversed() where position >= starts[index] {
      let offset = position - starts[index]
      // Past the end of the last chapter: park at its last moment.
      return (index, min(offset, max(0, tracks[index].duration - 0.25)))
    }
    return (0, 0)
  }

  private func rebuildQueue(from index: Int, offset: Double, landing: Double? = nil) {
    player.removeAllItems()
    itemIndex = [:]
    guard index < tracks.count else { seekTarget = nil; return }
    for i in index..<tracks.count { enqueue(i) }
    if offset > 0, let item = player.currentItem {
      item.seek(to: cmTime(offset), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
        if let landing { self?.seekLanded(landing) } else { self?.publish() }
      }
    } else if let landing {
      seekLanded(landing)
    }
  }

  private func enqueue(_ index: Int) {
    let item = AVPlayerItem(url: tracks[index].url)
    item.audioTimePitchAlgorithm = .timeDomain
    itemIndex[ObjectIdentifier(item)] = index
    player.insert(item, after: nil)
  }

  private func cmTime(_ seconds: Double) -> CMTime {
    CMTime(seconds: seconds, preferredTimescale: 600)
  }

  // MARK: Observation

  private func observePlayer() {
    timeObserver = player.addPeriodicTimeObserver(forInterval: cmTime(0.5), queue: .main) { [weak self] _ in
      self?.emitStatus()
    }
    observations = [
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.publish() }
      },
      player.observe(\.currentItem, options: [.new]) { [weak self] player, _ in
        DispatchQueue.main.async {
          guard let self else { return }
          self.watchItemStatus(player.currentItem)
          self.publish()
        }
      },
    ]
  }

  private func watchItemStatus(_ item: AVPlayerItem?) {
    itemStatusObservation = item?.observe(\.status, options: [.new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      DispatchQueue.main.async {
        self?.lastError = item.error?.localizedDescription ?? "Playback failed"
        self?.publish()
      }
    }
  }

  private func observeSession() {
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    center.addObserver(self, selector: #selector(onRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
  }

  @objc private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    DispatchQueue.main.async { [self] in
      switch type {
      case .began:
        resumeAfterInterruption = wantsPlay
        wantsPlay = false
        publish()
      case .ended:
        let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        if resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume) {
          play()
        }
        resumeAfterInterruption = false
      @unknown default:
        break
      }
    }
  }

  @objc private func onRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
    // Headphones out: stop, like every audio app.
    DispatchQueue.main.async { self.pause() }
  }

  private func activateSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
      try session.setActive(true)
    } catch {
      lastError = error.localizedDescription
    }
  }

  // MARK: Status

  var status: [String: Any] {
    [
      "episodeId": episode?.id as Any,
      "index": currentIndex,
      "position": position,
      "duration": totalDuration,
      // At the end wantsPlay stays set, so chapters that arrive later resume.
      "playing": wantsPlay && !isAtEnd,
      // An empty queue also reports waiting. That is the end, not buffering.
      "buffering": wantsPlay && !isAtEnd && player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
      "rate": Double(rate),
      "ended": isAtEnd,
      "error": lastError as Any,
    ]
  }

  private func emitStatus() {
    emit(status)
  }

  /// Sends status to JS and refreshes Now Playing.
  private func publish() {
    updateNowPlaying()
    emitStatus()
  }

  // MARK: Now Playing

  private func updateNowPlaying() {
    guard let episode else { return }
    let index = currentIndex
    let multi = tracks.count > 1
    let chapterTitle = tracks[safe: index]?.title
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: multi ? (chapterTitle ?? episode.title) : episode.title,
      MPMediaItemPropertyAlbumTitle: episode.title,
      MPMediaItemPropertyPlaybackDuration: totalDuration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
      MPNowPlayingInfoPropertyPlaybackRate: wantsPlay && player.timeControlStatus == .playing ? Double(rate) : 0.0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: Double(rate),
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
      MPNowPlayingInfoPropertyChapterNumber: index,
      MPNowPlayingInfoPropertyChapterCount: tracks.count,
      MPNowPlayingInfoPropertyExternalContentIdentifier: episode.id,
    ]
    info[MPMediaItemPropertyArtist] = multi ? episode.title : (episode.artist ?? "Fama")
    info[MPMediaItemPropertyArtwork] = artwork ?? Artwork.fallback(for: episode.title)
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func loadArtwork(for info: EpisodeInfo) {
    guard let url = info.artworkUrl else { return }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data, let image = UIImage(data: data) else { return }
      DispatchQueue.main.async {
        guard let self, self.episode?.id == info.id else { return }
        self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        self.updateNowPlaying()
      }
    }.resume()
  }

  // MARK: Remote commands

  private func setUpRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.addTarget { [weak self] _ in self?.play(); return .success }
    center.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      self.wantsPlay ? self.pause() : self.play()
      return .success
    }
    center.skipForwardCommand.preferredIntervals = [30]
    center.skipForwardCommand.addTarget { [weak self] event in
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 30
      self?.skip(by: interval)
      return .success
    }
    center.skipBackwardCommand.preferredIntervals = [15]
    center.skipBackwardCommand.addTarget { [weak self] event in
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 15
      self?.skip(by: -interval)
      return .success
    }
    // Headphone double and triple taps send next and previous track. Map them to skips, like Podcasts.
    center.nextTrackCommand.addTarget { [weak self] _ in self?.skip(by: 30); return .success }
    center.previousTrackCommand.addTarget { [weak self] _ in self?.skip(by: -15); return .success }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.seek(to: event.positionTime)
      return .success
    }
    center.changePlaybackRateCommand.supportedPlaybackRates = [0.75, 1, 1.25, 1.5, 2, 2.5, 3]
    center.changePlaybackRateCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
      self?.setRate(event.playbackRate)
      return .success
    }
  }
}

private enum Artwork {
  static func fallback(for title: String) -> MPMediaItemArtwork {
    let size = CGSize(width: 600, height: 600)
    let image = UIGraphicsImageRenderer(size: size).image { context in
      UIColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1).setFill()
      context.fill(CGRect(origin: .zero, size: size))
      let letter = String(title.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 300, weight: .bold),
        // Brand peach #EABB9F.
        .foregroundColor: UIColor(red: 0.918, green: 0.733, blue: 0.624, alpha: 1),
      ]
      let text = NSAttributedString(string: letter.isEmpty ? "F" : letter, attributes: attributes)
      let bounds = text.size()
      text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2))
    }
    return MPMediaItemArtwork(boundsSize: size) { _ in image }
  }
}

extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
