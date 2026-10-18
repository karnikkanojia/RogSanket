import AVFoundation
import AppKit
import SwiftUI

@MainActor
final class AudioCapture: ObservableObject {
    @Published var recording = false
    @Published var error = ""
    private var recorder: AVAudioRecorder?

    func start() async {
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            error = "Microphone access denied. Import a recording instead."
            return
        }
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("epicast-\(UUID().uuidString).wav")
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            ])
            guard recorder.record(forDuration: 300) else { throw URLError(.cannotCreateFile) }
            self.recorder = recorder
            recording = true
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    func stop() -> URL? {
        recorder?.stop()
        recording = false
        let url = recorder?.url
        recorder = nil
        return url
    }
}

@MainActor
final class PhotoCapture: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {
    @Published var running = false
    @Published var error = ""
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var completion: ((URL) -> Void)?

    func start() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
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
        } catch { self.error = error.localizedDescription }
    }

    func capture(_ completion: @escaping (URL) -> Void) {
        self.completion = completion
        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }

    func stop() {
        session.stopRunning()
        running = false
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = photo.fileDataRepresentation()
        let message = error?.localizedDescription
        Task { @MainActor in
            if let message { self.error = message }
            else if let data {
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("epicast-\(UUID().uuidString).jpg")
                do { try data.write(to: url); self.completion?(url) }
                catch { self.error = error.localizedDescription }
            }
            self.completion = nil
            self.stop()
        }
    }
}

struct CameraPreview: NSViewRepresentable {
    let session: AVCaptureSession
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
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
