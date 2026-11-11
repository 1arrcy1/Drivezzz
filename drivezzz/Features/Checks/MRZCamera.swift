import AVFoundation
import SwiftUI
import UIKit
import Vision

// The camera reading the code at the bottom of an ID. Our own and not Apple's text scanner (DataScannerViewController), which
// picks its lens by itself and gives whole blocks of text. The main lens of an iPhone 13 Pro can't focus closer than 20 cm, and an
// ID filling the screen without zoom is about 15 cm away, so the picture is blurry however long you wait. So: a camera of several
// lenses, which goes to the macro by itself when something is very close, and zoomed in so that the ID fills the frame from
// further away than the lens's closest focus.
@Observable
nonisolated final class MRZCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    var read = MRZRead()         // the most seen so far, sure or not: only for showing how far it got
    var confirmed = MRZRead()    // what's sure (MRZTally): all that leaves the scanner, also on Cancel
    var torchOn = false
    var problem: String?
    let session = AVCaptureSession()
    @ObservationIgnored var onDone: (@MainActor (MRZRead) -> Void)?

    @ObservationIgnored private var camera: AVCaptureDevice?
    @ObservationIgnored private var tally = MRZTally()
    @ObservationIgnored private var finished = false
    @ObservationIgnored private var focusingSince: Double?
    @ObservationIgnored private var region = CGRect(x: 0, y: 0.25, width: 1, height: 0.5)
    private let queue = DispatchQueue(label: "eu.drivezzz.mrz")

    #if DEBUG && targetEnvironment(simulator)
    static let available = true     // there's no camera here, but the screen can be looked at
    #else
    static let available = bestCamera() != nil
    #endif

    // In this order, so the one with the most lenses this iPhone has.
    private static func bestCamera() -> AVCaptureDevice? {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera], mediaType: .video, position: .back).devices.first
    }

    func start() {
        queue.async { [self] in
            guard !session.isRunning else { return }
            session.beginConfiguration()
            guard let camera = Self.bestCamera(), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
                session.commitConfiguration()
                show(String(localized: "The camera can’t be used. Type the details in instead."))
                return
            }
            session.addInput(input)
            // Zooming in crops the picture: 4K keeps enough of it to read small letters.
            session.sessionPreset = [.hd4K3840x2160, .hd1920x1080].first { session.canSetSessionPreset($0) } ?? .high
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
            session.commitConfiguration()
            self.camera = camera
            sharpen(camera)
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in if session.isRunning { session.stopRunning() } }
    }

    private func show(_ problem: String) {
        DispatchQueue.main.async { [self] in self.problem = problem }
    }

    private func sharpen(_ camera: AVCaptureDevice) {
        guard (try? camera.lockForConfiguration()) != nil else { return }
        defer { camera.unlockForConfiguration() }
        camera.videoZoomFactor = min(max(zoom(on: camera), camera.minAvailableVideoZoomFactor), camera.maxAvailableVideoZoomFactor)
        if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
        if camera.isAutoFocusRangeRestrictionSupported { camera.autoFocusRangeRestriction = .near }
        if camera.isExposureModeSupported(.continuousAutoExposure) { camera.exposureMode = .continuousAutoExposure }
    }

    // How far in, for an ID card filling the frame at a quarter past the main lens's closest focus. A passport is held further away.
    private func zoom(on camera: AVCaptureDevice) -> CGFloat {
        let main = camera.constituentDevices.first { $0.deviceType == .builtInWideAngleCamera } ?? camera
        let closest = main.minimumFocusDistance > 0 ? CGFloat(main.minimumFocusDistance) : 200      // mm
        let degrees = main.activeFormat.videoFieldOfView > 0 ? CGFloat(main.activeFormat.videoFieldOfView) : 69
        // The field of view is along the picture's long side; upright, across is the short side.
        let seenAcrossPerMm = 2 * tan(degrees / 2 * .pi / 180) * 9 / 16
        let cardFillsFrameAt = 85.6 / 0.75 / seenAcrossPerMm        // the frame is about three quarters of what the camera sees
        let wanted = min(max(1, closest * 1.25 / cardFillsFrameAt), 2.5)
        // The camera's zoom counts from its widest lens: on two of the three kinds that's the ultra wide, not the main lens.
        let mainAt = camera.deviceType == .builtInDualCamera ? 1 : camera.virtualDeviceSwitchOverVideoZoomFactors.first.map { CGFloat(truncating: $0) } ?? 1
        return wanted * mainAt
    }

    func toggleTorch() {
        queue.async { [self] in
            guard let camera, camera.hasTorch, (try? camera.lockForConfiguration()) != nil else { return }
            camera.torchMode = camera.torchMode == .on ? .off : .on
            let on = camera.torchMode == .on
            camera.unlockForConfiguration()
            DispatchQueue.main.async { [self] in torchOn = on }
        }
    }

    // The frame on screen as a part of the camera's upright picture, which fills the screen and has its edges cut off. Text is read
    // only there, and read better: it's not the whole picture shrunk. Vision measures from the bottom left.
    func aim(at frame: CGRect, on screen: CGSize) {
        guard screen.width > 0, screen.height > 0 else { return }
        let height = max(screen.height, screen.width * 16 / 9), width = height * 9 / 16
        let margin = frame.height * 0.12        // a hand isn't a tripod, and a passport's code is as wide as the frame
        let x = (frame.minX - margin + (width - screen.width) / 2) / width
        let top = (frame.minY - margin + (height - screen.height) / 2) / height
        let w = (frame.width + margin * 2) / width, h = (frame.height + margin * 2) / height
        let inside = CGRect(x: x, y: 1 - top - h, width: w, height: h).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        queue.async { [self] in region = inside }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !finished, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = ProcessInfo.processInfo.systemUptime
        // Not while the lens is still finding the ID: a picture half in focus is where most misreadings come from. Never more than a
        // second of that, in case a camera keeps saying it's focusing.
        if camera?.isAdjustingFocus == true {
            let since = focusingSince ?? time
            focusingSince = since
            if time - since < 1 { return }
        } else {
            focusingSince = nil
        }
        // The back camera's picture lies on its side. This takes a moment, and frames arriving meanwhile are dropped.
        let seen = MRZScan.lines(in: VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .right), region: region)
        tally.add(MRZScan.look(seen.lines, alternatives: seen.alternatives), at: time)
        let now = tally.read, sure = tally.confirmed
        // Done once the three parts that open the chip are sure: the name comes from the chip, so it isn't waited for.
        finished = tally.sure
        let done = finished
        if done { stop() }
        DispatchQueue.main.async { [self] in
            if read != now { read = now }
            if confirmed != sure { confirmed = sure }
            guard done else { return }
            MainActor.assumeIsolated {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onDone?(sure)
            }
        }
    }
}

// The screen around it: the camera, a frame the shape of an ID card, and how far it got. Cancelling hands over only the parts it
// was sure of: one that's only been seen might be a misreading, and a date from the scan isn't shown to check.
struct MRZScanner: View {
    var done: (MRZRead?) -> Void
    @State private var capture: MRZCapture?

    var body: some View {
        GeometryReader { geo in
            let frame = Self.frame(on: geo.size)
            ZStack {
                Theme.night
                if let capture { CameraPreview(session: capture.session) }
                FrameCutOut(frame: frame).fill(Theme.night.opacity(0.6), style: FillStyle(eoFill: true))
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(.white, lineWidth: 3)
                    .frame(width: frame.width, height: frame.height)
                    .position(x: frame.midX, y: frame.midY)
                Text("<<<<<<<<<<<<<<<<<<<<")
                    .font(.system(.footnote, design: .monospaced).weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(.white.opacity(0.65))
                    .position(x: frame.midX, y: frame.maxY - 26)
            }
            .onChange(of: geo.size, initial: true) { capture?.aim(at: frame, on: geo.size) }
            .onChange(of: capture == nil) { capture?.aim(at: frame, on: geo.size) }
        }
        .ignoresSafeArea()
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottom) { progress }
        .foregroundStyle(.white)
        .statusBarHidden()
        .task { await open() }
        .onDisappear { capture?.stop() }
    }

    private static func frame(on screen: CGSize) -> CGRect {
        let width = min(screen.width - 32, 520), height = min(width / 1.586, screen.height * 0.5)
        return CGRect(x: (screen.width - width) / 2, y: (screen.height - height) * 0.42, width: width, height: height)
    }

    private var topBar: some View {
        HStack {
            Button("Cancel") { capture?.stop(); done(capture?.confirmed) }
                .font(.body.weight(.semibold))
            Spacer()
            Button { capture?.toggleTorch() } label: {
                Image(systemName: capture?.torchOn == true ? "flashlight.on.fill" : "flashlight.off.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(capture?.torchOn == true ? 0.3 : 0.15), in: Circle())
            }
            .accessibilityLabel("Light")
        }
        .padding(.horizontal, 16)
    }

    private var progress: some View {
        // How far it got, without naming the parts: "born" and "valid until" are printed on the front, and sent people there. A
        // part seen but not yet sure is half lit, and then the screen asks to hold still while it makes sure.
        let read = capture?.read ?? MRZRead(), sure = capture?.confirmed ?? MRZRead()
        let seen = [read.number, read.birth, read.expiry].filter { $0 != nil }.count
        let parts = [sure.number, sure.birth, sure.expiry].filter { $0 != nil }.count
        return VStack(spacing: 14) {
            if let problem = capture?.problem {
                Text(problem).font(.headline).multilineTextAlignment(.center)
            } else {
                VStack(spacing: 4) {
                    Text(seen > 0 ? String(localized: "Hold still…") : String(localized: "The back of your ID card")).font(.headline)
                    Text("The side without your photo. Put the lines with <<< in the frame, about 25 cm from the phone.").font(.subheadline).opacity(0.85)
                    Text("Passport: the bottom of the photo page.").font(.footnote).opacity(0.7)
                }
                .multilineTextAlignment(.center)
            }
            HStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { i in
                    Capsule().fill(i < parts ? Theme.ok : i < max(seen, parts) ? Theme.ok.opacity(0.4) : .white.opacity(0.3)).frame(width: 28, height: 6)
                }
            }
            .animation(.easeOut(duration: 0.2), value: parts)
            .animation(.easeOut(duration: 0.2), value: seen)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(parts == 3 ? String(localized: "Read") : String(localized: "Reading, \(parts) of 3"))
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func open() async {
        let c = MRZCapture()
        c.onDone = { done($0) }
        capture = c
        var allowed = SelfieCapture.cameraAllowed
        if !allowed { allowed = await SelfieCapture.askCamera() }
        if allowed { c.start() } else { c.problem = String(localized: "Drivezzz needs the camera to read this. Allow it in Settings, or type the details in.") }
    }
}

private struct FrameCutOut: Shape {
    var frame: CGRect
    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addRoundedRect(in: frame, cornerSize: CGSize(width: 16, height: 16), style: .continuous)
        return path
    }
}
