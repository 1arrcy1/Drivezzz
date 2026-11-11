import SwiftUI

// Before a driver's first time online: what's theirs to look after. Drivezzz is in the Netherlands only for now; a car there also
// needs the checks (DriverChecksSheet), which come right after this. The server keeps when they saw this.
struct DriverRules: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var seen: () -> Void
    @State private var working = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HeroCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "checkmark.shield.fill").font(.system(size: 30, weight: .semibold))
                            Text("You drive for yourself").font(.title2.weight(.bold))
                            Text("Drivezzz is at its core a marketplace and doesn’t take responsibility for your insurance or licences. We do check what we can against the sources that exist. Driving a car? Verify to get a blue check. Having what the law asks stays up to you.")
                                .font(.subheadline)
                                .opacity(0.9)
                        }
                    }
                    CardGroup(title: String(localized: "What you need"), footer: String(localized: "A motor or scooter isn’t a taxi under Dutch law, so it needs no taxi permit or chauffeurskaart: the licence and insurance are still yours to have.")) {
                        need("person.text.rectangle.fill", String(localized: "A driving licence"), String(localized: "Valid for this vehicle."))
                        CardDivider()
                        need("doc.text.fill", String(localized: "For a car: taxi permits"), String(localized: "A taxi permit from Kiwa, a chauffeurskaart and blue plates. We check them next."))
                        CardDivider()
                        need("shield.lefthalf.filled", String(localized: "Insurance"), String(localized: "One that covers passengers who pay."))
                        CardDivider()
                        need("car.fill", String(localized: "A safe vehicle"), String(localized: "Road-legal, and kept that way."))
                    }
                    Link(destination: URL(string: "https://drivezzz.s3rver.nl/terms")!) {
                        Text("Read the terms").font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk)
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding(16)
            }
            .background(Theme.page)
            .foregroundStyle(Theme.ink)
            .navigationTitle("Before you drive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.foregroundStyle(Theme.accentInk) } }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await done() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Got it, go online") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
    }

    private func need(_ symbol: String, _ title: String, _ note: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(note).font(.footnote).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func done() async {
        working = true
        defer { working = false }
        await app.rulesSeen()
        dismiss()
        seen()
    }
}
