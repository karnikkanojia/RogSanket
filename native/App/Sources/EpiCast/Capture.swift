import AVFoundation
import AppKit
import SwiftUI

@MainActor
final class AudioCapture: NSObject, ObservableObject, AVAudioRecorderDelegate {
    enum Purpose { case dictation, cough }
    @Published var recording = false
    @Published var error = ""
    @Published private(set) var purpose: Purpose = .dictation
    private var recorder: AVAudioRecorder?
    private var completion: ((URL) -> Void)?
    private var generation = 0

    func start(purpose: Purpose, completion: @escaping (URL) -> Void) async {
        guard !recording else { return }
        let ticket = generation
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard ticket == generation else { return }
        guard allowed else {
            error = "Microphone access denied. Enable it in System Settings or import a recording."
            return
        }
        do {
            let url = try MediaFiles.newURL(extension: "wav")
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            ])
            recorder.delegate = self
            guard recorder.record(forDuration: purpose == .cough ? 2 : 300) else {
                try? FileManager.default.removeItem(at: url)
                throw URLError(.cannotCreateFile)
            }
            self.recorder = recorder
            self.purpose = purpose
            self.completion = completion
            recording = true
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    func stop() {
        guard let recorder else { return }
        self.recorder = nil
        recorder.stop()
        recording = false
        let callback = completion
        completion = nil
        callback?(recorder.url)
    }

    func discard() {
        generation += 1
        let url = recorder?.url
        recorder?.stop()
        recorder = nil; completion = nil; recording = false
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let url = recorder.url
        Task { @MainActor in
            guard self.recorder?.url == url else { return }
            if flag { self.stop() }
            else { self.discard(); self.error = "Recording failed. Check the microphone and try again." }
        }
    }
}

@MainActor
final class PhotoCapture: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {
    @Published var running = false
    @Published private(set) var capturing = false
    private var generation = 0
    @Published var error = ""
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var completion: ((URL) -> Void)?

    func start() async {
        guard !running else { return }
        let ticket = generation
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        guard ticket == generation else { return }
        guard allowed else {
            error = "Camera access denied. Import an image instead."
            return
        }
        do {
            guard let device = AVCaptureDevice.default(for: .video) else { throw URLError(.resourceUnavailable) }
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            for old in session.inputs { session.removeInput(old) }
            for old in session.outputs { session.removeOutput(old) }
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                throw URLError(.resourceUnavailable)
            }
            session.addInput(input)
            session.addOutput(output)
            session.commitConfiguration()
            session.startRunning()
            running = true
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    func capture(_ completion: @escaping (URL) -> Void) {
        guard running, !capturing else { return }
        capturing = true
        self.completion = completion
        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }

    func stop() {
        generation += 1
        completion = nil
        capturing = false
        session.stopRunning()
        running = false
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = photo.fileDataRepresentation()
        let message = error?.localizedDescription
        Task { @MainActor in
            if let message { self.error = message }
            else if let data, let completion = self.completion {
                do {
                    let url = try MediaFiles.newURL(extension: "jpg")
                    try data.write(to: url); completion(url)
                }
                catch { self.error = error.localizedDescription }
            }
            self.completion = nil
            self.stop()
        }
    }
}

final class CameraPreviewView: NSView {
    override func layout() {
        super.layout()
        layer?.frame = bounds
    }
}

struct CameraPreview: NSViewRepresentable {
    let session: AVCaptureSession
    func makeNSView(context: Context) -> NSView {
        let view = CameraPreviewView()
        view.wantsLayer = true
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer = preview
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {
        (view.layer as? AVCaptureVideoPreviewLayer)?.session = session
    }
}
