import CoreLocation
import Foundation
import SwiftUI

// Where this phone is. Drive mode and a ride under way keep it running in the background: that's what shows the
// blue bar, and nothing outside the app can stop it. A driver only goes offline by tapping Stop or closing the app.
@Observable
final class LocationService: NSObject, CLLocationManagerDelegate {
    static let shared = LocationService()

    private let manager = CLLocationManager()
    private var backgroundSession: CLBackgroundActivitySession?
    private(set) var status: CLAuthorizationStatus
    private(set) var location: CLLocation?
    // Changes once, not with every GPS fix: a view that reads `location` in its body is redone every second, map and all.
    private(set) var hasFix = false
    private(set) var inBackgroundMode = false

    var denied: Bool { status == .denied || status == .restricted }
    // Rough location can't tell if you're within 100 m of a car.
    var imprecise: Bool { allowed && accuracy == .reducedAccuracy }
    private(set) var accuracy: CLAccuracyAuthorization
    var allowed: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }

    override init() {
        status = manager.authorizationStatus
        accuracy = manager.accuracyAuthorization
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        location = manager.location
        hasFix = location != nil
    }

    func start() {
        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        if allowed { manager.startUpdatingLocation() }
    }

    func setNavigating(_ on: Bool) {
        manager.desiredAccuracy = on ? kCLLocationAccuracyBestForNavigation : kCLLocationAccuracyNearestTenMeters
    }

    func setBackground(_ on: Bool) {
        guard on != inBackgroundMode else { return }
        inBackgroundMode = on
        manager.allowsBackgroundLocationUpdates = on
        manager.showsBackgroundLocationIndicator = on
        if on {
            backgroundSession = CLBackgroundActivitySession()
            // Brings the app back if iOS ever ends it while driving.
            manager.startMonitoringSignificantLocationChanges()
            manager.startUpdatingLocation()
        } else {
            backgroundSession?.invalidate()
            backgroundSession = nil
            manager.stopMonitoringSignificantLocationChanges()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        status = manager.authorizationStatus
        accuracy = manager.accuracyAuthorization
        if allowed { manager.startUpdatingLocation() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        location = last
        if !hasFix { hasFix = true }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

// For what must follow every GPS fix: only this empty view is redone, not the screen around it with its map.
private struct LocationWatcher: View {
    var action: (CLLocation?) -> Void
    var body: some View {
        Color.clear.onChange(of: LocationService.shared.location) { _, here in action(here) }
    }
}

extension View {
    func onLocation(_ action: @escaping (CLLocation?) -> Void) -> some View {
        background(LocationWatcher(action: action).accessibilityHidden(true))
    }
}
