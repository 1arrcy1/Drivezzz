import PhotosUI
import SwiftUI
import Vision
import VisionKit

// Photographing the chauffeurskaart or taxi permit with the iPhone's document camera (it finds the edges and straightens it),
// and reading its text on the phone, so the number and the date it's valid until can be filled in for the driver to check.
struct DocumentCamera: UIViewControllerRepresentable {
    var done: (UIImage?) -> Void

    static var available: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            done(scan.pageCount > 0 ? scan.imageOfPage(at: 0) : nil)
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { done(nil) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { done(nil) }
    }
}

struct ReadDocument {
    var text: String
    var number: String?
    var validUntil: Date?
}

enum DocumentReader {
    // Every line of text in a picture, read on the phone.
    static func lines(in image: UIImage) async -> [String] {
        guard let cg = image.cgImage else { return [] }
        return await withCheckedContinuation { done in
            let request = VNRecognizeTextRequest { request, _ in
                let found = (request.results as? [VNRecognizedTextObservation] ?? []).compactMap { $0.topCandidates(1).first?.string }
                done.resume(returning: found)
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["nl-NL", "en-US"]
            request.usesLanguageCorrection = false
            DispatchQueue.global(qos: .userInitiated).async {
                do { try VNImageRequestHandler(cgImage: cg, orientation: .up).perform([request]) } catch { done.resume(returning: []) }
            }
        }
    }

    // The text on it, and a guess at its number and the last date on it (the one it's valid until).
    static func read(_ image: UIImage) async -> ReadDocument {
        let text = await lines(in: image).joined(separator: "\n")
        var dates: [Date] = []
        let calendar = Calendar(identifier: .gregorian)
        for m in text.matches(of: /(\d{2})[-.\/ ](\d{2})[-.\/ ](\d{4})/) {
            if let d = calendar.date(from: DateComponents(year: Int(m.3), month: Int(m.2), day: Int(m.1))), Int(m.2)! <= 12 { dates.append(d) }
        }
        // The longest run of letters and digits that has at least five digits and isn't a date.
        let tokens = text.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        let number = tokens.filter { $0.filter(\.isNumber).count >= 5 && $0.count <= 20 }.max(by: { $0.count < $1.count })
        return ReadDocument(text: String(text.prefix(3000)), number: number?.uppercased(), validUntil: dates.max())
    }

    // Small enough to send, sharp enough to read.
    static func jpeg(_ image: UIImage, longest: CGFloat = 1600) -> Data? {
        let scale = min(1, longest / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.75)
    }
}
