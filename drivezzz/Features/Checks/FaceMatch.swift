import CoreGraphics
import CoreML
import Foundation
import Vision

// Comparing two faces on the phone: the photo in an ID's chip and a selfie. Neither leaves the phone; only the score is sent.
// Vision finds the face and its eyes, nose and mouth; the face is turned and scaled so those sit where the model expects
// (112 × 112, ArcFace's five points), and SFace (OpenCV Zoo, Apache-2.0, SFace-LICENSE.txt) turns it into 128 numbers. Two faces
// are compared by the cosine of their numbers: the same person usually 0.4 to 0.8, two people under 0.3. The server decides
// what passes (rules.faceAutoMatch).
enum FaceMatchError: LocalizedError {
    case noFace, manyFaces, model

    var errorDescription: String? {
        switch self {
        case .noFace: String(localized: "No face found.")
        case .manyFaces: String(localized: "More than one face: only you in the picture.")
        case .model: String(localized: "The face check couldn’t start. Update Drivezzz.")
        }
    }
}

final class FaceMatcher: @unchecked Sendable {
    static let shared = FaceMatcher()
    static let modelName = "sface-2021dec-fp16"
    // What the server takes as the same person (rules.faceAutoMatch in server/src/config.js): only for what the result screen
    // says. The server decides.
    static let samePerson = 0.40
    private var model: MLModel?
    private let lock = NSLock()

    // Where SFace wants the eyes, the tip of the nose and the corners of the mouth, left to right as seen in the picture.
    private static let template: [CGPoint] = [
        CGPoint(x: 38.2946, y: 51.6963), CGPoint(x: 73.5318, y: 51.5014), CGPoint(x: 56.0252, y: 71.7366),
        CGPoint(x: 41.5493, y: 92.3655), CGPoint(x: 70.7299, y: 92.2041),
    ]
    private static let side = 112

    // Made when first used: loading it takes a moment.
    private func loadedModel() throws -> MLModel {
        lock.lock(); defer { lock.unlock() }
        if let model { return model }
        guard let url = Bundle.main.url(forResource: "SFace", withExtension: "mlmodelc") else { throw FaceMatchError.model }
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let made = try MLModel(contentsOf: url, configuration: config)
        model = made
        return made
    }

    // The 128 numbers of the biggest face in an upright picture.
    func features(of image: CGImage, onlyOne: Bool = false) throws -> [Float] {
        let request = VNDetectFaceLandmarksRequest()
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        let faces = request.results ?? []
        if onlyOne, faces.filter({ $0.boundingBox.width > 0.12 }).count > 1 { throw FaceMatchError.manyFaces }
        guard let face = faces.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }),
              let points = Self.fivePoints(face, size: CGSize(width: image.width, height: image.height)) else { throw FaceMatchError.noFace }
        let aligned = try Self.align(image, points)
        // The face and its mirror image together (as face recognition is usually measured): the same numbers whichever way round a
        // picture is, and steadier for a face lit from one side. The selfie here is mirrored, the ID's photo isn't, and a face isn't
        // quite the same as its mirror image, which cost the match. As FaceMatch.kt.
        let straight = try embed(aligned, mirrored: false), mirror = try embed(aligned, mirrored: true)
        var v = zip(straight, mirror).map { $0 + $1 }
        let norm = sqrt(v.reduce(0) { $0 + $1 * $1 })
        if norm > 0 { v = v.map { $0 / norm } }
        return v
    }

    // SFace's 128 numbers for an aligned face (RGBA bytes, 112 × 112), as it is or mirrored left to right.
    private func embed(_ aligned: [UInt8], mirrored: Bool) throws -> [Float] {
        let side = Self.side, plane = side * side
        let input = try MLMultiArray(shape: [1, 3, NSNumber(value: side), NSNumber(value: side)], dataType: .float32)
        let out = input.dataPointer.bindMemory(to: Float32.self, capacity: 3 * plane)
        for y in 0..<side {
            for x in 0..<side {
                let from = (y * side + (mirrored ? side - 1 - x : x)) * 4, i = y * side + x
                out[i] = Float32(aligned[from])                 // red
                out[plane + i] = Float32(aligned[from + 1])     // green
                out[2 * plane + i] = Float32(aligned[from + 2]) // blue
            }
        }
        let result = try loadedModel().prediction(from: MLDictionaryFeatureProvider(dictionary: ["face": MLFeatureValue(multiArray: input)]))
        guard let feature = result.featureValue(for: "feature")?.multiArrayValue else { throw FaceMatchError.model }
        return (0..<feature.count).map { Float(truncating: feature[$0]) }
    }

    static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        for i in a.indices { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
        return na > 0 && nb > 0 ? Double(dot / (na.squareRoot() * nb.squareRoot())) : 0
    }

    // Eyes, nose tip and mouth corners in pixels from the top left, left to right as seen.
    private static func fivePoints(_ face: VNFaceObservation, size: CGSize) -> [CGPoint]? {
        guard let marks = face.landmarks, let eye1 = marks.leftEye, let eye2 = marks.rightEye, let lips = marks.outerLips else { return nil }
        func points(_ region: VNFaceLandmarkRegion2D) -> [CGPoint] {
            region.pointsInImage(imageSize: size).map { CGPoint(x: $0.x, y: size.height - $0.y) }
        }
        func centre(_ p: [CGPoint]) -> CGPoint {
            CGPoint(x: p.map(\.x).reduce(0, +) / CGFloat(max(p.count, 1)), y: p.map(\.y).reduce(0, +) / CGFloat(max(p.count, 1)))
        }
        let a = centre(points(eye1)), b = centre(points(eye2))
        let (leftEye, rightEye) = a.x < b.x ? (a, b) : (b, a)
        // The tip: the lowest point of the nose's crest, else the middle of the nose.
        let nose: CGPoint
        if let crest = marks.noseCrest, let tip = points(crest).max(by: { $0.y < $1.y }) { nose = tip }
        else if let n = marks.nose { nose = centre(points(n)) } else { return nil }
        let mouth = points(lips)
        guard let left = mouth.min(by: { $0.x < $1.x }), let right = mouth.max(by: { $0.x < $1.x }) else { return nil }
        return [leftEye, rightEye, nose, left, right]
    }

    // The face, turned and scaled onto the template: RGBA bytes, 112 × 112, rows from the top.
    private static func align(_ image: CGImage, _ src: [CGPoint]) throws -> [UInt8] {
        // A least-squares turn, scale and shift (no stretching) from the five points to the template.
        let n = CGFloat(src.count)
        let ms = CGPoint(x: src.map(\.x).reduce(0, +) / n, y: src.map(\.y).reduce(0, +) / n)
        let md = CGPoint(x: template.map(\.x).reduce(0, +) / n, y: template.map(\.y).reduce(0, +) / n)
        var num1: CGFloat = 0, num2: CGFloat = 0, den: CGFloat = 0
        for (s, d) in zip(src, template) {
            let xs = s.x - ms.x, ys = s.y - ms.y, xd = d.x - md.x, yd = d.y - md.y
            num1 += xs * xd + ys * yd
            num2 += xs * yd - ys * xd
            den += xs * xs + ys * ys
        }
        guard den > 0 else { throw FaceMatchError.noFace }
        let a = num1 / den, b = num2 / den
        let toTemplate = CGAffineTransform(a: a, b: b, c: -b, d: a, tx: md.x - (a * ms.x - b * ms.y), ty: md.y - (b * ms.x + a * ms.y))
        // Core Graphics counts from the bottom: flip into top-left space, move, flip back out.
        let h = CGFloat(image.height), s = CGFloat(side)
        let fromSource = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: h)
        let toTarget = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: s)
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let ctx = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.concatenate(fromSource.concatenating(toTemplate).concatenating(toTarget))
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        guard drawn else { throw FaceMatchError.model }
        return bytes
    }
}
