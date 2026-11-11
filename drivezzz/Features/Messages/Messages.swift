import SwiftUI

// The Chat tab, beside Profile for riding and driving.
struct ChatTab: View {
    var body: some View {
        NavigationStack { MessagesScreen() }
    }
}

// Your chats. The server can't read them, so the previews are opened here, on the phone.
struct MessagesScreen: View {
    @Environment(AppState.self) private var app
    @State private var chats: [ChatSummary] = []
    @State private var loaded = false
    @State private var removing: ChatSummary?
    @State private var profileOf: ChatPerson?

    var body: some View {
        List {
            if loaded, chats.isEmpty {
                Text("No messages yet. You can message a driver from their page.").font(.subheadline).foregroundStyle(Theme.muted)
            }
            ForEach(chats) { chat in
                NavigationLink { ChatScreen(userId: chat.person.id, name: chat.person.name ?? String(localized: "Someone")) } label: { row(chat) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { removing = chat } label: { Label("Remove", systemImage: "trash") }.tint(Theme.danger)
                    }
                    // Holding a chat: only a driver has a profile to open.
                    .contextMenu {
                        if chat.person.isDriver == true {
                            Button { profileOf = chat.person } label: { Label("Open profile", systemImage: "person.crop.circle") }
                        }
                        Button(role: .destructive) { removing = chat } label: { Label("Remove", systemImage: "trash") }
                    }
            }
        }
        .navigationTitle("Chat")
        .foregroundStyle(Theme.ink)
        .task(id: app.rev) { await load() }
        .sheet(item: $profileOf) { person in NavigationStack { DriverProfileView(driverId: person.id) } }
        .confirmationDialog("Remove this chat?", isPresented: asking, titleVisibility: .visible, presenting: removing) { chat in
            Button("Remove chat", role: .destructive) { Task { await remove(chat) } }
        } message: { chat in
            Text(removalNote(chat.person.name ?? String(localized: "The other person")))
        }
    }

    private var asking: Binding<Bool> {
        Binding { removing != nil } set: { if !$0 { removing = nil } }
    }

    private func remove(_ chat: ChatSummary) async {
        withAnimation { chats.removeAll { $0.id == chat.id } }
        try? await APIClient.shared.call("DELETE", "/api/messages/\(chat.id)")
        await load()
    }

    private func row(_ chat: ChatSummary) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(chat.person.name ?? String(localized: "Someone")).font(.body.weight(chat.unread ?? 0 > 0 ? .semibold : .regular))
                Text(preview(chat)).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                if let at = chat.lastAt { Text(Fmt.dayTime(Date(ms: at))).font(.caption).foregroundStyle(Theme.faint) }
                if let unread = chat.unread, unread > 0 {
                    Text("\(unread)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.accent, in: Capsule())
                }
            }
        }
    }

    private func preview(_ chat: ChatSummary) -> String {
        guard let last = chat.last else { return "" }
        let words = E2E.shared.open(last) ?? String(localized: "Can’t be read on this phone")
        return last.fromMe == true ? String(localized: "You: \(words)") : words
    }

    private func load() async {
        if let id = app.user?.id { await E2E.shared.prepare(accountId: id) }
        if let r: ChatList = try? await APIClient.shared.get("/api/messages") {
            chats = r.conversations ?? []
            loaded = true
        }
    }
}

private func removalNote(_ name: String) -> String {
    String(localized: "It’s removed for you. \(name) keeps their copy until they remove it too, and a report can still include it.")
}

struct ChatScreen: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var userId: String
    var name: String
    @State private var chat: ChatThread?
    @State private var draft = ""
    @State private var draftField = UUID()
    @FocusState private var typing: Bool
    @State private var sending = false
    @State private var error: String?
    @State private var confirmRemove = false
    @State private var showProfile = false

    private var shownName: String { chat?.with?.name ?? name }
    private var hasProfile: Bool { chat?.with?.isDriver == true }
    private var messages: [ChatMessage] { chat?.messages ?? [] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 8) {
                    Label("Only you and \(shownName) can read these messages. If one of you reports the other, this chat is added to the report.", systemImage: "lock.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(.bottom, 4)
                    ForEach(messages) { message in
                        bubble(message).id(message.id)
                    }
                }
                .padding(12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.last?.id) { _, last in
                if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(shownName)
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .toolbar {
            // The top of the chat opens their profile, as in other chat apps. Only a driver has one.
            ToolbarItem(placement: .principal) {
                if hasProfile {
                    Button { showProfile = true } label: {
                        VStack(spacing: 0) {
                            Text(shownName).font(.headline).foregroundStyle(Theme.ink).lineLimit(1)
                            Text("Tap for their profile").font(.caption2).foregroundStyle(Theme.faint)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens their profile")
                } else {
                    Text(shownName).font(.headline).foregroundStyle(Theme.ink).lineLimit(1)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                PersonMenu(userId: userId, name: shownName, offersChat: false, onRemoveChat: messages.isEmpty ? nil : { confirmRemove = true })
            }
        }
        .sheet(isPresented: $showProfile) { NavigationStack { DriverProfileView(driverId: userId) } }
        .onAppear { app.chatsOpen += 1 }
        .onDisappear { app.chatsOpen -= 1 }
        .task(id: app.rev) { await load() }
        .confirmationDialog("Remove this chat?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove chat", role: .destructive) {
                Task {
                    try? await APIClient.shared.call("DELETE", "/api/messages/\(userId)")
                    dismiss()
                }
            }
        } message: {
            Text(removalNote(shownName))
        }
    }

    private func bubble(_ message: ChatMessage) -> some View {
        let mine = message.fromMe == true
        let words = E2E.shared.open(message)
        return VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            Text(words ?? String(localized: "This message can’t be read on this phone."))
                .font(words == nil ? .subheadline.italic() : .body)
                .foregroundStyle(mine ? Theme.onAccent : Theme.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(mine ? Theme.accent : Theme.soft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .textSelection(.enabled)
            if let at = message.at { Text(Fmt.time(Date(ms: at))).font(.caption2).foregroundStyle(Theme.faint) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(mine ? .leading : .trailing, 44)
    }

    @ViewBuilder
    private var composer: some View {
        if let chat {
            VStack(alignment: .leading, spacing: 6) {
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                if chat.canSend == true {
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("Message", text: $draft, axis: .vertical)
                            .focused($typing)
                            .id(draftField)
                            .lineLimit(1...6)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .frame(minHeight: 46)
                            .background(Theme.soft, in: RoundedRectangle(cornerRadius: 23, style: .continuous))
                        Button { Task { await send() } } label: {
                            Group {
                                if sending { ProgressView().tint(Theme.onAccent) } else { Image(systemName: "arrow.up").font(.headline) }
                            }
                            .foregroundStyle(Theme.onAccent)
                            .frame(width: 46, height: 46)
                            .background(Theme.accent, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Send")
                    }
                    if let left = chat.messagesLeft {
                        Text(left == 1 ? String(localized: "You can send 1 more before \(shownName) replies.") : String(localized: "You can send \(left) more before \(shownName) replies."))
                            .font(.caption)
                            .foregroundStyle(Theme.faint)
                    }
                } else if let why = chat.why {
                    Label(why, systemImage: "hourglass").labelStyle(.titleAndIcon).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
        }
    }

    private func load() async {
        if let id = app.user?.id { await E2E.shared.prepare(accountId: id) }
        do {
            let fresh: ChatThread = try await APIClient.shared.get("/api/messages/\(userId)")
            chat = fresh
            if (fresh.messages ?? []).contains(where: { $0.fromMe != true && $0.readAt == nil }) {
                try? await APIClient.shared.call("POST", "/api/messages/\(userId)/read")
            }
        } catch { self.error = error.localizedDescription }
    }

    private func send(again: Bool = true) async {
        let words = String(draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
        guard !words.isEmpty else { return }
        // Nobody else can check a sealed message for abuse, so it's done here.
        if MessageFilter.isBlocked(words) {
            error = String(localized: "That message has a word that isn’t allowed.")
            return
        }
        guard let theirs = chat?.with?.publicKey else { return }
        sending = true
        error = nil
        defer { sending = false }
        do {
            let sealed = try E2E.shared.seal(words, to: theirs)
            let fresh: ChatThread = try await APIClient.shared.post("/api/messages/\(userId)", ["body": sealed.body, "senderKey": sealed.senderKey, "toKey": theirs])
            chat = fresh
            draft = ""
            // A field with focus keeps showing its old text otherwise, and the next message is added to it.
            typing = false
            draftField = UUID()
            Task {
                try? await Task.sleep(for: .milliseconds(100))
                typing = true
            }
        } catch let e as APIError where e.code == "key_changed" && again {
            // They have a new phone: seal it again for that one.
            await load()
            await send(again: false)
        } catch { self.error = error.localizedDescription }
    }
}

// The words that aren't allowed, from the server, the same rules as for names and reviews.
enum MessageFilter {
    private static var words = Set(UserDefaults.standard.stringArray(forKey: "filterWords") ?? [])
    private static let lookalikes: [Character: Character] = ["0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"]

    static func load() async {
        struct Response: Codable { var words: [String]? }
        guard let r: Response = try? await APIClient.shared.get("/api/filter"), let list = r.words else { return }
        words = Set(list)
        UserDefaults.standard.set(list, forKey: "filterWords")
    }

    static func isBlocked(_ text: String) -> Bool {
        let plain = String(text.lowercased().folding(options: .diacriticInsensitive, locale: nil).map { lookalikes[$0] ?? $0 })
        let parts = plain.split { !("a"..."z").contains(String($0)) }.map(String.init)
        if parts.contains(where: words.contains) { return true }
        let squashed = parts.joined()
        return squashed.count >= 6 && words.contains(squashed)
    }
}
