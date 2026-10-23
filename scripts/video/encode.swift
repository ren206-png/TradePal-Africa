import AVFoundation
import AppKit

// usage: encode FRAMES_DIR FPS AUDIO.m4a OUT.mp4 WIDTH HEIGHT
// Writes the PNG frames as H.264 video, then joins the AAC narration track into one MP4. Only Apple frameworks; nothing to download.
let a = CommandLine.arguments
guard a.count == 7, let fps = Int32(a[2]), let width = Int(a[5]), let height = Int(a[6]) else { fputs("usage: encode FRAMES FPS AUDIO OUT W H\n", stderr); exit(2) }
let framesDir = a[1], audioPath = a[3], outPath = a[4]
let tmp = outPath + ".video.mp4"
try? FileManager.default.removeItem(atPath: tmp)
try? FileManager.default.removeItem(atPath: outPath)

let files = try FileManager.default.contentsOfDirectory(atPath: framesDir).filter { $0.hasSuffix(".png") }.sorted()
let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: tmp), fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_100_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func buffer(_ path: String) -> CVPixelBuffer? {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pb)
  guard let p = pb else { return nil }
  CVPixelBufferLockBaseAddress(p, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(p), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(p), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
  CVPixelBufferUnlockBaseAddress(p, [])
  return p
}

for (i, f) in files.enumerated() {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
  guard let pb = buffer(framesDir + "/" + f) else { fputs("cannot read \(f)\n", stderr); exit(1) }
  adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { fputs("video failed: \(String(describing: writer.error))\n", stderr); exit(1) }

// join video + narration
let comp = AVMutableComposition()
let v = AVURLAsset(url: URL(fileURLWithPath: tmp)), au = AVURLAsset(url: URL(fileURLWithPath: audioPath))
let vt = try await v.loadTracks(withMediaType: .video)[0], at = try await au.loadTracks(withMediaType: .audio)[0]
let vdur = try await v.load(.duration)
let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try cv.insertTimeRange(CMTimeRange(start: .zero, duration: vdur), of: vt, at: .zero)
let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
let adur = try await au.load(.duration)
try ca.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(adur, vdur)), of: at, at: .zero)
guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { fputs("no export session\n", stderr); exit(1) }
ex.outputURL = URL(fileURLWithPath: outPath); ex.outputFileType = .mp4; ex.shouldOptimizeForNetworkUse = true
await ex.export()
if ex.status != .completed { fputs("export failed: \(String(describing: ex.error))\n", stderr); exit(1) }
try? FileManager.default.removeItem(atPath: tmp)
print("ok")
