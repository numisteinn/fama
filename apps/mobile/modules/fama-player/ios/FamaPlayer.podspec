Pod::Spec.new do |s|
  s.name           = 'FamaPlayer'
  s.version        = '1.0.0'
  s.summary        = 'Episode playback, Now Playing and AirPlay for Fama.'
  s.author         = 'Fama'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
