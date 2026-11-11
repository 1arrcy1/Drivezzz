import Foundation
import Observation

// A route someone keeps, with a name of their own, so they needn't pick the same two spots again.
struct SavedRoute: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var pickup: Place
    var dropoff: Place
}

// They stay on this phone, per account: the server never sees them. Privacy says so.
@Observable
final class SavedRoutes {
    static let shared = SavedRoutes()

    private(set) var routes: [SavedRoute] = []
    @ObservationIgnored private var account: String?

    private func key(_ account: String) -> String { "savedRoutes.\(account)" }

    func use(account: String?) {
        guard account != self.account else { return }
        self.account = account
        guard let account, let data = UserDefaults.standard.data(forKey: key(account)) else { routes = []; return }
        routes = (try? JSONDecoder().decode([SavedRoute].self, from: data)) ?? []
    }

    private func save() {
        guard let account, let data = try? JSONEncoder().encode(routes) else { return }
        UserDefaults.standard.set(data, forKey: key(account))
    }

    // Without what the server added: it looks for the nearest road again each time.
    func add(name: String, pickup: Place, dropoff: Place) {
        let shown = name.trimmingCharacters(in: .whitespacesAndNewlines)
        routes.append(SavedRoute(name: shown.isEmpty ? (dropoff.label ?? String(localized: "My route")) : shown,
                                 pickup: Place(lat: pickup.lat, lng: pickup.lng, label: pickup.label),
                                 dropoff: Place(lat: dropoff.lat, lng: dropoff.lng, label: dropoff.label)))
        save()
    }

    func rename(_ route: SavedRoute, to name: String) {
        let shown = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !shown.isEmpty, let i = routes.firstIndex(where: { $0.id == route.id }) else { return }
        routes[i].name = shown
        save()
    }

    func remove(_ route: SavedRoute) {
        routes.removeAll { $0.id == route.id }
        save()
    }

    // The same two spots, give or take where the road was found: about 50 m.
    func has(pickup: Place?, dropoff: Place?) -> Bool {
        guard let pickup, let dropoff else { return false }
        let close = { (a: Place, b: Place) in abs(a.lat - b.lat) < 0.0005 && abs(a.lng - b.lng) < 0.0008 }
        return routes.contains { close($0.pickup, pickup) && close($0.dropoff, dropoff) }
    }

    func forget(account: String?) {
        guard let account else { return }
        UserDefaults.standard.removeObject(forKey: key(account))
        if account == self.account { routes = [] }
    }
}
