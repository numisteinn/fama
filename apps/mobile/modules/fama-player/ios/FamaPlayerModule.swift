import AVKit
import ExpoModulesCore

struct TrackRecord: Record {
  @Field var url: String = ""
  @Field var title: String = ""
  @Field var durationMs: Double = 0
}

struct LoadRecord: Record {
  @Field var episodeId: String = ""
  @Field var title: String = ""
  @Field var artist: String? = nil
  @Field var artworkUrl: String? = nil
  @Field var tracks: [TrackRecord] = []
  @Field var expectsMore: Bool = false
  @Field var position: Double = 0
  @Field var rate: Double = 1
  @Field var autoplay: Bool = false
}

private func toTracks(_ records: [TrackRecord]) -> [Track] {
  records.compactMap { record in
    guard let url = URL(string: record.url) else { return nil }
    return Track(url: url, title: record.title, duration: record.durationMs / 1000)
  }
}

public class FamaPlayerModule: Module {
  // Built on first use. Every function runs on the main queue.
  private lazy var player: EpisodePlayer = EpisodePlayer { [weak self] status in
    self?.sendEvent("onStatus", status)
  }

  public func definition() -> ModuleDefinition {
    Name("FamaPlayer")

    Events("onStatus")

    AsyncFunction("load") { (record: LoadRecord) in
      let info = EpisodeInfo(
        id: record.episodeId,
        title: record.title,
        artist: record.artist,
        artworkUrl: record.artworkUrl.flatMap(URL.init(string:))
      )
      self.player.load(
        info, tracks: toTracks(record.tracks), expectsMore: record.expectsMore,
        position: record.position, rate: Float(record.rate), autoplay: record.autoplay
      )
    }.runOnQueue(.main)

    AsyncFunction("updateTracks") { (tracks: [TrackRecord], expectsMore: Bool) in
      self.player.updateTracks(toTracks(tracks), expectsMore: expectsMore)
    }.runOnQueue(.main)

    AsyncFunction("play") { self.player.play() }.runOnQueue(.main)
    AsyncFunction("pause") { self.player.pause() }.runOnQueue(.main)
    AsyncFunction("seek") { (position: Double) in self.player.seek(to: position) }.runOnQueue(.main)
    AsyncFunction("skip") { (delta: Double) in self.player.skip(by: delta) }.runOnQueue(.main)
    AsyncFunction("setRate") { (rate: Double) in self.player.setRate(Float(rate)) }.runOnQueue(.main)
    AsyncFunction("unload") { self.player.unload() }.runOnQueue(.main)
    AsyncFunction("getStatus") { () -> [String: Any] in self.player.status }.runOnQueue(.main)

    View(RouteButtonView.self) {
      Prop("tint") { (view: RouteButtonView, color: UIColor) in
        view.picker.tintColor = color
      }
      Prop("activeTint") { (view: RouteButtonView, color: UIColor) in
        view.picker.activeTintColor = color
      }
    }
  }
}

/// The system AirPlay and Bluetooth route picker.
final class RouteButtonView: ExpoView {
  let picker = AVRoutePickerView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.prioritizesVideoDevices = false
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }
}
