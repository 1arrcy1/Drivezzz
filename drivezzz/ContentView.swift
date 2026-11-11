import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .loading: LoadingView()
            case .intro: IntroView()
            case .name: NameView().pageWidth()
            case .main: MainView()
            case .banned: BanView().pageWidth()
            }
        }
        // The colours are read when views are made, so a new accent makes them again.
        .id(app.accent)
        .animation(.easeInOut(duration: 0.25), value: app.phase)
    }
}

struct MainView: View {
    @Environment(AppState.self) private var app
    private let location = LocationService.shared

    var body: some View {
        if location.denied || location.imprecise {
            LocationNeededView(imprecise: location.imprecise).pageWidth()
        } else {
            MainTabs()
        }
    }
}

// Riding and driving are one set of tabs around one Profile, and the switch only swaps the tabs around it. Two sets
// meant building one and throwing the other away at every switch: a freeze, and you could land on another page.
struct MainTabs: View {
    @Environment(AppState.self) private var app

    private var driving: Bool { app.mode == .driver && app.user?.isDriver == true }

    var body: some View {
        TabView(selection: tab) {
            if driving {
                DrivingView()
                    .tabItem { Label("Driving", systemImage: "steeringwheel") }
                    .tag(0)
                DriverMapView()
                    .tabItem { Label("Map", systemImage: "map.fill") }
                    .tag(1)
                // Chat is top right on Drives: iPhone shows five tabs.
                DrivesView()
                    .pageWidth()
                    .tabItem { Label("Drives", systemImage: "list.bullet.rectangle") }
                    .badge(app.unreadMessages)
                    .tag(2)
                MyPageView()
                    .pageWidth()
                    .tabItem { Label("My page", systemImage: "car.2.fill") }
                    .tag(3)
            } else {
                HomeView()
                    .tabItem { Label("Home", systemImage: "car.fill") }
                    .tag(0)
                RidesView()
                    .pageWidth()
                    .tabItem { Label("Rides", systemImage: "list.bullet.rectangle") }
                    .tag(1)
                ChatTab()
                    .pageWidth()
                    .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                    .badge(app.unreadMessages)
                    .tag(2)
            }
            ProfileView()
                .pageWidth()
                .tabItem { Label("Profile", systemImage: "person.fill") }
                .tag(AppState.profileTab)
        }
        .background {
            ChecksSheetHost()
            RideSheetHost()
        }
        .task(id: app.user?.id) { SavedRoutes.shared.use(account: app.user?.id) }
        // Opens by itself when the driver is close. It can be dismissed, and opened again from Rides.
        .sheet(item: checkInRide) { ride in
            CheckInView(ride: ride)
        }
        .sheet(item: shownRide) { ride in
            NavigationStack { RideDetailView(ride: ride) }
        }
        .sheet(item: offer) { ride in
            OfferView(ride: ride)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .safetyQuestion()
    }

    private var tab: Binding<Int> {
        Binding {
            driving ? app.driverTab : app.riderTab
        } set: { value in
            if driving { app.driverTab = value } else { app.riderTab = value }
        }
    }

    private var checkInRide: Binding<Ride?> {
        Binding {
            guard !driving, let ride = app.ride, ride.canCheckIn == true, app.dismissedCheckIn != ride.id, app.showingRide == nil, app.rideOnScreen != ride.id else { return nil }
            return ride
        } set: { value in
            if value == nil, let id = app.ride?.id { app.dismissedCheckIn = id }
        }
    }

    private var shownRide: Binding<Ride?> {
        Binding { driving ? nil : app.showingRide } set: { app.showingRide = $0 }
    }

    private var offer: Binding<Ride?> {
        // Swiped down, a request stays in Current on Drives until its time is up.
        Binding {
            !driving || app.driving.offer?.id == app.parkedOffer ? nil : app.driving.offer
        } set: { value in
            if value == nil, let id = app.driving.offer?.id {
                app.parkedOffer = id
                app.drivesPart = 0
            }
        }
    }
}

// Is everything OK? Asked when the rider's phone and the car drift apart during a ride.
private struct SafetyQuestion: ViewModifier {
    @Environment(AppState.self) private var app

    func body(content: Content) -> some View {
        content.alert("Is everything OK?", isPresented: asked) {
            Button("I’m OK") { answer(true) }
            Button("Something’s wrong", role: .destructive) {
                answer(false)
                if let url = URL(string: "tel://112") { UIApplication.shared.open(url) }
            }
        } message: {
            Text("Your phone and the car seem to be going different ways.")
        }
    }

    private var asked: Binding<Bool> {
        Binding { app.mode == .rider && app.ride?.safetyAsked == true } set: { _ in }
    }

    private func answer(_ ok: Bool) {
        guard let id = app.ride?.id else { return }
        Task {
            let _: RideResponse? = try? await APIClient.shared.post("/api/rides/\(id)/safety", ["ok": ok])
            await app.syncNow()
        }
    }
}

extension View {
    func safetyQuestion() -> some View { modifier(SafetyQuestion()) }
}

struct LocationNeededView: View {
    var imprecise = false
    @State private var showProfile = false

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "location.slash.fill")
                .font(.system(size: 46))
                .foregroundStyle(Theme.accentInk)
            Text(imprecise ? String(localized: "We need your precise location") : String(localized: "We need your location to use this app"))
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.ink)
            Text(imprecise ? String(localized: "Rides are checked in within 100 m of the car. In Settings → Location, turn on Precise Location.") : String(localized: "Drivers and riders find each other by location, and rides are checked in and out with it."))
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.muted)
            Spacer()
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(PrimaryButtonStyle())
            Button("Profile and account") { showProfile = true }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 36)
        }
        .padding(24)
        .sheet(isPresented: $showProfile) { ProfileView() }
    }
}
