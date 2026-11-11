import SwiftUI

// The End User Licence Agreement, opened by Continue on the first screen. Accept makes the account, Decline goes back. The words come
// from the server (server/public/eula.html), so they're the website's, and the account keeps which version was accepted.
struct EulaView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var eula: Eula?
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    ScreenTitle(title: String(localized: "End User Licence Agreement"), subtitle: eula?.updated.map { String(localized: "Last updated \($0)") })
                    if let eula {
                        EulaBlocks(blocks: eula.short ?? [])
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        ForEach(eula.sections ?? []) { section in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(section.title).font(.headline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                                EulaBlocks(blocks: section.blocks)
                            }
                        }
                    } else if error == nil {
                        ProgressView().tint(Theme.accentInk).frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(24)
                .frame(maxWidth: Room.page, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            footer
        }
        .background(Theme.page)
        .tint(Theme.accentInk)
        .interactiveDismissDisabled(working)
        .task { await load() }
    }

    private var footer: some View {
        VStack(spacing: 10) {
            ErrorText(text: error)
            Text("By tapping Accept you confirm you’re 18 or over, and you accept this agreement and the [Terms](https://drivezzz.s3rver.nl/terms). How we handle your data is in the [Privacy Policy](https://drivezzz.s3rver.nl/privacy).")
                .font(.caption)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button { Task { await primary() } } label: {
                if working { ProgressView().tint(Theme.onAccent) } else { Text(eula == nil ? String(localized: "Try again") : String(localized: "Accept")) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(working || (eula == nil && error == nil))
            Button("Decline") { dismiss() }
                .buttonStyle(GhostButtonStyle())
                .disabled(working)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .frame(maxWidth: Room.page)
    }

    private func load() async {
        do {
            let latest: Eula = try await APIClient.shared.get("/api/eula")
            eula = latest
            error = nil
        } catch {
            if eula == nil { self.error = error.localizedDescription }
        }
    }

    private func primary() async {
        guard let eula else {
            error = nil
            await load()
            return
        }
        working = true
        error = nil
        defer { working = false }
        do {
            try await app.continueNew(eula: eula.version)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            // It may have changed while it was being read: what shows next is what can be accepted.
            await load()
        }
    }
}

private struct EulaBlocks: View {
    let blocks: [Eula.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks.indices, id: \.self) { i in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if blocks[i].bullet == true { Text("•").foregroundStyle(Theme.faint) }
                    Text(Self.styled(blocks[i].text))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.subheadline)
            }
        }
    }

    // Bold and links, from the page's text.
    private static func styled(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}
