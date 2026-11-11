import Foundation
import Security

enum ServerConfig {
    static let production = URL(string: "https://drivezzz.s3rver.nl")!

    // Always the real server. In debug builds a test server can be set from the Mac (the one that's always on is
    // http://your-server:8090) with `xcrun simctl spawn booted defaults write eu.drivezzz.app serverURLOverride http://localhost:8081`,
    // or on an iPhone with `xcrun devicectl device process launch … eu.drivezzz.app -- -serverURLOverride http://…`, which stays until launched with "".
    static var testServer: URL? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-serverURLOverride"), i + 1 < args.count { UserDefaults.standard.set(args[i + 1], forKey: "serverURLOverride") }
        if let raw = UserDefaults.standard.string(forKey: "serverURLOverride"), let url = URL(string: raw), url.scheme != nil { return url == production ? nil : url }
        #endif
        return nil
    }
    static var baseURL: URL { testServer ?? production }

    // For the line at the bottom of Profile in a debug build: which server this is.
    static var shownServer: String {
        #if DEBUG
        testServer == nil ? String(localized: " · live server") : String(localized: " · test server")
        #else
        ""
        #endif
    }

    // A random id for this phone, kept in the Keychain so a ban survives reinstalling the app.
    static let deviceId: String = {
        if let existing = Keychain.read("deviceId") { return existing }
        let id = UUID().uuidString
        Keychain.write("deviceId", id)
        return id
    }()
}

struct APIError: LocalizedError, Equatable {
    let status: Int
    let message: String
    var code: String?
    var extra: [String: Double] = [:]

    var errorDescription: String? { message }
    static let offline = APIError(status: 0, message: String(localized: "Can’t reach Drivezzz. Check your connection."))
}

enum Keychain {
    // A test server has its own login and phone id, so trying it leaves this phone's real account alone.
    private static var service: String { ServerConfig.testServer == nil ? "eu.drivezzz.app" : "eu.drivezzz.app.test" }

    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

// What the app has sent and received, to keep an eye on the data budget (30 MB an hour while driving).
@Observable
final class DataMeter {
    static let shared = DataMeter()
    private(set) var bytes = 0
    private var startedAt = Date()
    private let overhead = 700 // headers and TLS records per request, roughly

    func add(_ count: Int) { bytes += count + overhead }
    func reset() { bytes = 0; startedAt = Date() }
    var megabytesPerHour: Double {
        let hours = max(Date().timeIntervalSince(startedAt) / 3600, 1.0 / 60)
        return Double(bytes) / 1_000_000 / hours
    }
}

// The server's clock, so countdowns are right on a phone whose clock is a little off.
enum ServerClock {
    static var ahead = 0.0
    static func date(_ ms: Double) -> Date { Date(ms: ms - ahead) }
}

final class APIClient {
    static let shared = APIClient()
    private let session: URLSession

    // Asked for with every request, on the main thread: the Keychain is only read the first time.
    private var storedToken: String??
    var token: String? {
        get {
            if let storedToken { return storedToken }
            let saved = Keychain.read("token")
            storedToken = .some(saved)
            return saved
        }
        set {
            storedToken = .some(newValue)
            Keychain.write("token", newValue)
        }
    }

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 40
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    private func request(_ method: String, _ path: String) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: ServerConfig.baseURL)!)
        req.httpMethod = method
        req.setValue(ServerConfig.deviceId, forHTTPHeaderField: "X-Device-Id")
        req.setValue("drivezzz-ios/1", forHTTPHeaderField: "X-Client")
        req.setValue(Lang.code, forHTTPHeaderField: "Accept-Language")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // Waiting for news takes up to a minute, and that's fine.
        if path.contains("wait=") { req.timeoutInterval = 70 }
        return req
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { throw CancellationError() }
            throw APIError.offline
        }
        DataMeter.shared.add(data.count + (req.httpBody?.count ?? 0))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let now = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Now").flatMap(Double.init) { ServerClock.ahead = now - Date().ms }
        guard (200..<300).contains(status) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let extra = (json ?? [:]).compactMapValues { $0 as? Double }
            throw APIError(status: status, message: json?["error"] as? String ?? String(localized: "Something went wrong. Try again."), code: json?["code"] as? String, extra: extra)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("[decode]", req.url?.path ?? "", error)
            #endif
            throw APIError(status: status, message: String(localized: "This version of the app can’t read that. Update the app."))
        }
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await perform(request("GET", path))
    }

    func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any] = [:]) async throws -> T {
        var req = request(method, path)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(req)
    }

    func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:]) async throws -> T {
        try await send("POST", path, body)
    }

    @discardableResult
    func call(_ method: String, _ path: String, _ body: [String: Any] = [:]) async throws -> Empty {
        try await send(method, path, body)
    }

    func upload<T: Decodable>(_ path: String, jpeg: Data, headers: [String: String] = [:]) async throws -> T {
        var req = request("POST", path)
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        for (name, value) in headers { req.setValue(value, forHTTPHeaderField: name) }
        req.httpBody = jpeg
        return try await perform(req)
    }

    func imageURL(_ path: String) -> URL? { URL(string: path, relativeTo: ServerConfig.baseURL) }

    // For when the app is closing: there's no time for anything to come back.
    func fireAndWait(_ method: String, _ path: String, seconds: Double) {
        var req = request(method, path)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + seconds)
    }
}

struct Empty: Decodable {}
