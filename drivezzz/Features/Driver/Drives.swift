import SwiftUI

// A driver's drives: the one on now, the planned ones as an agenda, and the finished ones. Chat is top right.
struct DrivesView: View {
    @Environment(AppState.self) private var app
    @State private var rides: [Ride] = []
    @State private var loaded = false

    private var current: Ride? { app.driving.drive ?? rides.first(where: \.isLive) }
    private var planned: [Ride] { rides.filter { $0.status == "scheduled" || ($0.needsPayment && $0.scheduledAt != nil) }.sorted { ($0.scheduledAt ?? 0) < ($1.scheduledAt ?? 0) } }
    private var finished: [Ride] { rides.filter(\.isOver).sorted { finishedAt($0) > finishedAt($1) } }

    var body: some View {
        @Bindable var app = app
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Picker("Drives", selection: $app.drivesPart) {
                        Text("Current").tag(0)
                        Text(planned.isEmpty ? String(localized: "Planned") : String(localized: "Planned · \(planned.count)")).tag(1)
                        Text("Completed").tag(2)
                    }
                    .pickerStyle(.segmented)
                    switch app.drivesPart {
                    case 0: currentPart
                    case 1: plannedPart
                    default: finishedPart
                    }
                }
                .padding(16)
            }
            .background(Theme.page)
            .navigationTitle("Drives")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink { MessagesScreen() } label: { ChatButton(unread: app.unreadMessages) }
                }
            }
            .foregroundStyle(Theme.ink)
            .task(id: app.rev) { await load() }
            .refreshable { await load() }
        }
    }

    // ---------- current ----------

    @ViewBuilder
    private var currentPart: some View {
        if let offer = app.driving.offer {
            OfferCard(ride: offer, mapHeight: 170).card(radius: 24, padding: 16)
        }
        if let ride = current {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    StatusPill(text: Self.driverStatus(ride), ride: ride)
                    if ride.needsPayment, ride.scheduledAt == nil, let by = ride.payBy { Countdown(until: by) }
                    Spacer()
                    Text(Fmt.eur(ride.shownPriceCents)).font(.title2.weight(.bold).monospacedDigit()).kerning(-0.5)
                }
                RouteStops(from: ride.pickup.label, to: ride.dropoff.label)
                HStack(spacing: 14) {
                    if let name = ride.rider?.name { Fact(symbol: "person.fill", text: name) }
                    Fact(symbol: "point.topleft.down.to.point.bottomright.curvepath", text: Fmt.km(ride.distanceM))
                    Fact(symbol: "clock", text: Fmt.minutes(ride.durationS))
                }
                Button(ride.navigationTarget == nil || ride.status == "riding" ? String(localized: "Open the drive") : String(localized: "Go to rider")) {
                    app.driveOpen = true
                    app.driverTab = 0
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .card(radius: 24, padding: 16)
            Text("While you have a rider you can’t claim another drive.").font(.footnote).foregroundStyle(Theme.faint)
        } else if app.driving.offer == nil {
            EmptyPart(symbol: "steeringwheel", title: String(localized: "No drive right now"), text: String(localized: "Go online on the Driving tab and claim an order, or wait for one to be offered to you.")) {
                Button("Go to Driving") { app.driverTab = 0 }.buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    // ---------- planned: an agenda ----------

    @ViewBuilder
    private var plannedPart: some View {
        if planned.isEmpty {
            EmptyPart(symbol: "calendar", title: String(localized: "Nothing planned"), text: app.driver?.allowsPlanning == true
                      ? String(localized: "Planned orders show on the map in yellow. Claim one and it shows here, by day.")
                      : String(localized: "Turn on planning on My page, and riders can book you for later.")) {
                if app.driver?.allowsPlanning != true { Button("Open My page") { app.driverTab = 3 }.buttonStyle(PrimaryButtonStyle()) }
            }
        } else {
            ForEach(days(planned, at: { $0.scheduledAt }), id: \.day) { group in
                VStack(alignment: .leading, spacing: 8) {
                    DayHeader(day: group.day)
                    ForEach(group.rides) { ride in
                        NavigationLink { RideDetailView(ride: ride) } label: { AgendaRow(ride: ride) }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // ---------- completed ----------

    @ViewBuilder
    private var finishedPart: some View {
        if finished.isEmpty {
            EmptyPart(symbol: "checkmark.seal", title: loaded ? String(localized: "No drives yet") : String(localized: "Loading…"), text: String(localized: "Your finished drives and what you earned show here.")) { EmptyView() }
        } else {
            ForEach(days(finished, at: finishedAt), id: \.day) { group in
                VStack(alignment: .leading, spacing: 8) {
                    DayHeader(day: group.day, trailing: Fmt.eur(group.rides.filter { $0.status == "completed" }.compactMap(\.priceCents).reduce(0, +)))
                    VStack(spacing: 0) {
                        ForEach(group.rides) { ride in
                            NavigationLink { RideDetailView(ride: ride) } label: { FinishedRow(ride: ride, at: finishedAt(ride)) }.buttonStyle(.plain)
                            if ride.id != group.rides.last?.id { Divider().padding(.leading, 14) }
                        }
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
                }
            }
        }
    }

    // ---------- helpers ----------

    private func finishedAt(_ ride: Ride) -> Double { ride.checkedOutAt ?? ride.cancelledAt ?? ride.scheduledAt ?? ride.createdAt ?? 0 }

    private func days(_ list: [Ride], at: (Ride) -> Double?) -> [(day: Date, rides: [Ride])] {
        var out: [(day: Date, rides: [Ride])] = []
        for ride in list {
            let day = Calendar.current.startOfDay(for: Date(ms: at(ride) ?? 0))
            if out.last?.day == day { out[out.count - 1].rides.append(ride) } else { out.append((day, [ride])) }
        }
        return out
    }

    static func driverStatus(_ ride: Ride) -> String {
        switch ride.status {
        case "awaiting_payment": String(localized: "Waiting for payment")
        case "accepted": String(localized: "On the way to the pickup")
        case "arrived": String(localized: "At the pickup")
        case "riding": String(localized: "Riding to the drop-off")
        case "scheduled": String(localized: "Planned")
        case "completed": String(localized: "Completed")
        case "cancelled": String(localized: "Cancelled")
        default: ride.statusTitle
        }
    }

    private func load() async {
        if let r: RidesResponse = try? await APIClient.shared.get("/api/driver/rides") { rides = r.rides ?? [] }
        loaded = true
    }
}

// The chat bubble with the number of unread messages on it.
struct ChatButton: View {
    var unread: Int

    var body: some View {
        Image(systemName: "bubble.left.and.bubble.right.fill")
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.accentInk)
            .frame(width: 36, height: 36)
            .overlay(alignment: .topTrailing) {
                if unread > 0 {
                    Text(unread > 9 ? "9+" : "\(unread)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Theme.danger, in: Capsule())
                        .offset(x: 6, y: -4)
                }
            }
            .accessibilityLabel(unread > 0 ? String(localized: "Chat, \(unread) unread") : String(localized: "Chat"))
    }
}

// From and to, joined by a line, like a route.
struct RouteStops: View {
    var from: String?
    var to: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 3) {
                Circle().stroke(Theme.ink, lineWidth: 3.5).frame(width: 12, height: 12)
                Rectangle().fill(Theme.ink.opacity(0.18)).frame(width: 2, height: 22)
                RoundedRectangle(cornerRadius: 2.5).fill(Theme.ink).frame(width: 12, height: 12)
            }
            .padding(.top, 3)
            VStack(alignment: .leading, spacing: 15) {
                Text(from ?? String(localized: "Pickup")).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(to ?? String(localized: "Drop-off")).font(.subheadline.weight(.semibold)).lineLimit(1)
            }
        }
    }
}

private struct Fact: View {
    var symbol: String
    var text: String

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.muted)
            .lineLimit(1)
    }
}

private struct DayHeader: View {
    var day: Date
    var trailing: String?

    private var title: String {
        if Calendar.current.isDateInToday(day) { return String(localized: "Today") }
        if Calendar.current.isDateInTomorrow(day) { return String(localized: "Tomorrow") }
        if Calendar.current.isDateInYesterday(day) { return String(localized: "Yesterday") }
        return day.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.weight(.bold)).kerning(-0.3)
            Spacer()
            if let trailing { Text(trailing).font(.subheadline.weight(.bold).monospacedDigit()).foregroundStyle(Theme.ink) }
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }
}

// One planned drive in the agenda: the time it starts and ends, then where to.
private struct AgendaRow: View {
    var ride: Ride

    private var start: Date { Date(ms: ride.scheduledAt ?? 0) }
    private var end: Date { start.addingTimeInterval(TimeInterval(ride.durationS ?? 0)) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.time(start)).font(.subheadline.weight(.bold).monospacedDigit())
                Text(Fmt.time(end)).font(.caption.monospacedDigit()).foregroundStyle(Theme.faint)
            }
            .frame(width: 58, alignment: .trailing)
            RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 4)
            VStack(alignment: .leading, spacing: 6) {
                Text(ride.dropoff.label ?? String(localized: "Drop-off")).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("From \(ride.pickup.label ?? String(localized: "the pickup"))").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                HStack(spacing: 12) {
                    Fact(symbol: "person.2.fill", text: Fmt.people(ride.passengers))
                    Fact(symbol: "point.topleft.down.to.point.bottomright.curvepath", text: Fmt.km(ride.distanceM))
                    if ride.pets == true { Fact(symbol: "pawprint.fill", text: "Pet") }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                Text(Fmt.eur(ride.shownPriceCents)).font(.subheadline.weight(.bold).monospacedDigit())
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
        .contentShape(Rectangle())
    }
}

private struct FinishedRow: View {
    var ride: Ride
    var at: Double

    private var done: Bool { ride.status == "completed" }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: done ? "checkmark" : "xmark")
                .font(.footnote.weight(.bold))
                .foregroundStyle(done ? Theme.ok : Theme.danger)
                .frame(width: 32, height: 32)
                .background(done ? Theme.okSoft : Theme.dangerSoft, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(ride.dropoff.label ?? String(localized: "Drop-off")).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(Fmt.time(Date(ms: at))) · \(done ? Fmt.km(ride.distanceM) : String(localized: "Cancelled"))\(done && ride.isCash ? String(localized: " · Paid in cash") : "")").font(.caption).foregroundStyle(Theme.faint)
            }
            Spacer(minLength: 4)
            Text(done ? Fmt.eur(ride.priceCents) : "–")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(done ? Theme.ink : Theme.faint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

private struct EmptyPart<Action: View>: View {
    var symbol: String
    var title: String
    var text: String
    @ViewBuilder var action: Action

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.accentInk)
                .frame(width: 64, height: 64)
                .background(Theme.accentSoft, in: Circle())
            Text(title).font(.title3.weight(.bold)).kerning(-0.3)
            Text(text).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            action.padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .padding(.horizontal, 20)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .lifted(0.45, radius: 24)
    }
}
