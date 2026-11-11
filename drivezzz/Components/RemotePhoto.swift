import ImageIO
import SwiftUI

// Car photos. Decoded away from the screen, so a sheet sliding up doesn't wait for a JPEG, and kept, so opening one again is instant.
enum PhotoCache {
    private static let kept: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 60
        return cache
    }()

    static func cached(_ url: URL) -> UIImage? { kept.object(forKey: url as NSURL) }

    static func load(_ url: URL) async -> UIImage? {
        if let image = cached(url) { return image }
        guard let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        let image = await Task.detached(priority: .userInitiated) { decode(data) }.value
        if let image { kept.setObject(image, forKey: url as NSURL) }
        return image
    }

    // Uploads are at most 1400 px on the long side.
    private static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 1400,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

struct RemotePhoto: View {
    var url: URL?
    var contentMode: ContentMode = .fill
    var placeholder: Color = Theme.soft
    @State private var loaded: UIImage?

    var body: some View {
        Group {
            if let image = loaded ?? url.flatMap(PhotoCache.cached) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder
            }
        }
        .task(id: url) {
            guard let url else { return }
            loaded = await PhotoCache.load(url)
        }
    }
}
