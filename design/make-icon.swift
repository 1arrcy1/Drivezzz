// Draws the app icon: a white road in the shape of a Z with a dashed middle line, on blue, 1024 px.
// Run: swift design/make-icon.swift drivezzz/Assets.xcassets/AppIcon.appiconset/icon-1024.png
// The same mark is ZRoad in the app (Core/Theme.swift) and logo.svg on the website; keep them in step.
import AppKit

let size = 1024.0
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
// No alpha channel: the App Store refuses an icon that has one.
let cg = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
// iOS rounds the corners itself, so the blue fills the whole square.
let top = NSColor(srgbRed: 0x2F / 255, green: 0x7B / 255, blue: 1, alpha: 1).cgColor
let bottom = NSColor(srgbRed: 0x0B / 255, green: 0x4F / 255, blue: 0xD6 / 255, alpha: 1).cgColor
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [top, bottom] as CFArray, locations: [0, 1])!
cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: 0, y: 0), options: [])
cg.translateBy(x: 0, y: size)
cg.scaleBy(x: 1, y: -1)
let s = size / 1000
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
let road = CGMutablePath()
road.addLines(between: [p(270, 290), p(730, 290), p(270, 710), p(730, 710)])
cg.addPath(road)
cg.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
cg.setLineWidth(150 * s)
cg.setLineCap(.round)
cg.setLineJoin(.round)
cg.strokePath()
cg.addPath(road)
cg.setStrokeColor(bottom)
cg.setLineWidth(16 * s)
cg.setLineDash(phase: 0, lengths: [46 * s, 52 * s])
cg.strokePath()
try! NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote", out)
