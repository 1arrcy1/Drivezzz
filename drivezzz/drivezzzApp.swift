import SwiftUI
import UIKit
import UserNotifications

// Started from main.swift, which picks the language first.
struct drivezzzApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppState.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(\.locale, Lang.locale)
                .tint(app.accent.deep)
                .preferredColorScheme(app.colorScheme)
                .task {
                    while !Task.isCancelled {
                        app.checkOutside()
                        try? await Task.sleep(for: .seconds(60))
                    }
                }
                .onChange(of: LocationService.shared.hasFix) { _, _ in app.checkOutside() }
                .labelStyle(AccentLabelStyle())
                .task { await app.start() }
                .onChange(of: scenePhase) { _, phase in
                    app.sceneChanged(active: phase == .active)
                    if phase == .active {
                        Wallets.shared.resume()
                        app.checkOutside()
                    }
                }
                .onOpenURL { Wallets.shared.handle($0) }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        AppAccent.current.applyToControls()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppState.shared.pushToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    // Swiping the app away is one of the two ways to stop driving. iOS ending the app itself doesn't come here,
    // so Drive mode picks up again when iOS brings the app back.
    func applicationWillTerminate(_ application: UIApplication) {
        AppState.shared.closingApp()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // With the app open the screen itself shows what happened.
        []
    }
}
