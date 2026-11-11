import AVFoundation
import CoreImage
import SwiftUI
import UIKit
import Vision

// The selfie: the front camera, and a turn of the head one way and then the other, in the order the server asked. A photo held
// up to the camera can't do that. Two straight-on pictures (before and after) are what's compared with the ID; the pictures stay
// in memory and are gone when this closes. As Selfie.kt.
//
// Made to be hard to get stuck in (Pieter, 7 November 2026: it took too long and people got frustrated): an arrow and four marks
// say where you are, a turn counts from how you held your head looking straight (a phone held to one side tilts that), turning
// the same way twice says "the other way" instead of asking again for a way it won't take, a tip comes after 8 seconds on one
// step, and it gives up only after 2 minutes.
@Observable
final class SelfieCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    enum Phase: Equatable { case starting, straight, turn(Int), straightAgain, done, failed(String) }
    enum Side { case left, right }

    var phase: Phase = .starting
    var hint = String(localized: "Look straight at the camera")
    var wrongWay = false        // the second turn went the first one's way: "the other way", and no arrow
    let session = AVCaptureSession()
    var steps: [String] = ["left", "right"]
    private(set) var pictures: [CGImage] = []
    private var firstTurnSign: Double = 0
    private var baseline: Double = 0           // the yaw looking straight, which turns count from
    private var straightYaws: [Double] = []
    private var backInMiddle = false           // after the first turn, back to straight before the second
    private var steadyFrames = 0
    private var lastFrame = Date.distantPast
    private var startedAt = Date()
    private var stepStartedAt = Date()

    // The way to turn now, as you see yourself: the picture is mirrored, so your left is the screen's left.
    var arrow: Side? {
        guard case .turn(let i) = phase, !wrongWay else { return nil }
        return steps[safe: i] == "left" ? .left : .right
    }

    // How many steps are done, of `stepCount`: looking straight, the two turns, and straight again.
    var stepsDone: Int {
        switch phase {
        case .starting, .straight, .failed: 0
        case .turn(let i): 1 + i
        case .straightAgain: 3
        case .done: stepCount
        }
    }
    var stepCount: Int { steps.isEmpty ? 1 : 4 }
    private let queue = DispatchQueue(label: "eu.drivezzz.selfie")
    private let context = CIContext()
    var onDone: (([CGImage]) -> Void)?

    static var cameraAllowed: Bool { AVCaptureDevice.authorizationStatus(for: .video) == .authorized }
    static func askCamera() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }

    func start() {
        queue.async { [self] in
            guard !session.isRunning else { return }
            session.beginConfiguration()
            session.sessionPreset = .high
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                  let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
                session.commitConfiguration()
                set(.failed(String(localized: "The front camera can’t be used.")), hint: "")
                return
            }
            session.addInput(input)
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
            session.commitConfiguration()
            session.startRunning()
            startedAt = Date()
            stepStartedAt = startedAt
            set(.straight, hint: String(localized: "Look straight at the camera"))
        }
    }

    func stop() {
        queue.async { [self] in if session.isRunning { session.stopRunning() } }
    }

    private func set(_ phase: Phase, hint: String, wrongWay: Bool = false) {
        DispatchQueue.main.async { [self] in
            if self.phase != phase { self.phase = phase }
            if self.hint != hint { self.hint = hint }
            if self.wrongWay != wrongWay { self.wrongWay = wrongWay }
            if phase == .done { onDone?(pictures) }
        }
    }

    // On to the next step, with a tap you can feel.
    private func advance(_ phase: Phase, hint: String) {
        stepStartedAt = Date()
        backInMiddle = false
        set(phase, hint: hint)
        DispatchQueue.main.async { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    }

    private func side(_ i: Int) -> String { steps[safe: i] == "left" ? String(localized: "left") : String(localized: "right") }
    private func turnHint(_ i: Int) -> String { i == 0 ? String(localized: "Turn your head to the \(side(i))") : String(localized: "Now turn your head to the \(side(i))") }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        // About 8 looks a second is plenty.
        guard Date().timeIntervalSince(lastFrame) > 0.12, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrame = Date()
        if Date().timeIntervalSince(startedAt) > 120 {
            set(.failed(String(localized: "That took too long. Try again in good light, with the phone in front of your face.")), hint: "")
            stop()
            return
        }
        let stuck = Date().timeIntervalSince(stepStartedAt) > 8
        let current = DispatchQueue.main.sync { phase }
        guard [.straight, .straightAgain].contains(current) || { if case .turn = current { return true }; return false }() else { return }
        // The front camera's picture lies on its side, mirrored.
        let request = VNDetectFaceRectanglesRequest()
        request.revision = VNDetectFaceRectanglesRequestRevision3
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .leftMirrored).perform([request])
        let faces = (request.results ?? []).filter { $0.boundingBox.width > 0.15 }
        guard faces.count == 1, let face = faces.first else {
            steadyFrames = 0
            straightYaws = []
            let lost = stuck ? String(localized: "Hold the phone in front of your face, in good light") : String(localized: "Bring your face into the circle")
            set(current, hint: faces.isEmpty ? lost : String(localized: "Only you in the picture"), wrongWay: wrongWay)
            return
        }
        let yaw = face.yaw?.doubleValue ?? 0
        let roll = face.roll?.doubleValue ?? 0
        switch current {
        case .straight, .straightAgain:
            guard abs(yaw) < 0.2, abs(roll) < 0.3, face.boundingBox.width > 0.25 else {
                steadyFrames = 0
                straightYaws = []
                let level = stuck ? String(localized: "Look into the camera, not at the screen, and keep your head level") : String(localized: "Look straight at the camera")
                set(current, hint: face.boundingBox.width <= 0.25 ? String(localized: "Come a little closer") : level)
                return
            }
            steadyFrames += 1
            straightYaws.append(yaw)
            guard steadyFrames >= 3 else { return }
            if current == .straight { baseline = straightYaws.reduce(0, +) / Double(straightYaws.count) }
            steadyFrames = 0
            straightYaws = []
            let image = CIImage(cvPixelBuffer: pixels).oriented(.leftMirrored)
            guard let picture = context.createCGImage(image, from: image.extent) else { return }
            pictures.append(picture)
            // No turns asked (a person compares the face): one picture is enough.
            if current == .straight, !steps.isEmpty { advance(.turn(0), hint: turnHint(0)) } else { stop(); advance(.done, hint: String(localized: "Got it")) }
        case .turn(let i):
            let turned = yaw - baseline
            if abs(turned) < 0.15 { backInMiddle = true }
            guard abs(turned) > 0.3 else {
                if stuck, !wrongWay { set(current, hint: String(localized: "Turn your head further to the \(side(i)), slowly")) }
                return
            }
            let sign = turned > 0 ? 1.0 : -1.0
            if i == 0 {
                firstTurnSign = sign
                advance(.turn(1), hint: turnHint(1))
            } else if sign == -firstTurnSign {
                advance(.straightAgain, hint: String(localized: "And look straight at the camera again"))
            } else if backInMiddle {
                // The same way as the first turn: whichever of the two went the wrong way, the other way is the one left.
                set(current, hint: String(localized: "Not that way: turn your head the other way"), wrongWay: true)
            }
        default:
            return
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// The camera's picture, mirrored like a mirror, in a circle.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.preview.session = session
        view.preview.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}
