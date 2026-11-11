package eu.drivezzz.app.features

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.ApiError
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.ChatList
import eu.drivezzz.app.core.ChatMessage
import eu.drivezzz.app.core.ChatPerson
import eu.drivezzz.app.core.ChatSummary
import eu.drivezzz.app.core.ChatThread
import eu.drivezzz.app.core.E2E
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.MessageFilter
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// The Chat tab, beside Profile for riding and driving.
@Composable
fun ChatTab() {
    NavStack { MessagesScreen() }
}

private fun removalNote(name: String) = "It’s removed for you. $name keeps their copy until they remove it too, and a report can still include it."

// Your chats. The server can't read them, so the previews are opened here, on the phone.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val nav = LocalNav.current
    var chats by remember { mutableStateOf<List<ChatSummary>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<ChatSummary?>(null) }
    var profileOf by remember { mutableStateOf<ChatPerson?>(null) }

    suspend fun load() {
        app.user?.id?.let { E2E.prepare(it) }
        attempt { ApiClient.get<ChatList>("/api/messages") }?.let {
            chats = it.conversations ?: emptyList()
            loaded = true
        }
    }
    LaunchedEffect(app.rev) { load() }

    Screen("Chat", large = true, scroll = true, spacing = 10.dp) {
        if (loaded && chats.isEmpty()) {
            ListSection { ListRow { Text("No messages yet. You can message a driver from their page.", style = T.subheadline, color = Theme.muted) } }
        }
        chats.forEach { chat ->
            androidx.compose.runtime.key(chat.id) {
                val state = rememberSwipeToDismissBoxState(
                    confirmValueChange = { value ->
                        if (value == SwipeToDismissBoxValue.EndToStart) removing = chat
                        false
                    },
                )
                SwipeToDismissBox(
                    state = state,
                    enableDismissFromStartToEnd = false,
                    backgroundContent = {
                        Box(Modifier.fillMaxSize().background(Theme.danger, RoundedCornerShape(14.dp)).padding(end = 20.dp), contentAlignment = Alignment.CenterEnd) {
                            Icon(Sym.trash, "Remove", tint = androidx.compose.ui.graphics.Color.White)
                        }
                    },
                ) {
                    ChatRow(
                        chat,
                        onOpen = { nav?.push { ChatScreen(chat.person.id, chat.person.name ?: "Someone") } },
                        onProfile = if (chat.person.isDriver == true) ({ profileOf = chat.person }) else null,
                        onRemove = { removing = chat },
                    )
                }
            }
        }
    }
    profileOf?.let { person ->
        DzSheet(onDismiss = { profileOf = null }) { NavStack { DriverProfileScreen(person.id, close = { profileOf = null }) } }
    }
    removing?.let { chat ->
        AskDialog(
            title = "Remove this chat?",
            message = removalNote(chat.person.name ?: "The other person"),
            choices = listOf(
                Choice("Remove chat", destructive = true) {
                    chats = chats.filter { it.id != chat.id }
                    scope.launch {
                        attempt { ApiClient.call("DELETE", "/api/messages/${chat.id}") }
                        load()
                    }
                },
            ),
            onDismiss = { removing = null },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(chat: ChatSummary, onOpen: () -> Unit, onProfile: (() -> Unit)?, onRemove: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val unread = chat.unread ?: 0
    fun preview(): String {
        val last = chat.last ?: return ""
        val words = E2E.open(last) ?: "Can’t be read on this phone"
        return if (last.fromMe == true) "You: $words" else words
    }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .background(Theme.card, RoundedCornerShape(14.dp))
                .clip(RoundedCornerShape(14.dp))
                // Holding a chat: only a driver has a profile to open.
                .combinedClickable(onLongClick = { menu = true }, onClick = onOpen)
                .padding(horizontal = 16.dp, vertical = 11.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(chat.person.name ?: "Someone", style = if (unread > 0) T.callout.semibold else T.callout, color = Theme.ink)
                Text(preview(), style = T.subheadline, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                chat.lastAt?.let { Text(Fmt.dayTime(it), style = T.caption, color = Theme.faint) }
                if (unread > 0) {
                    Text("$unread", style = T.caption2.bold, color = Theme.onAccent, modifier = Modifier.background(Theme.accent, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp))
                }
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Theme.card, shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp)) {
            val scope = MenuScope { menu = false }
            if (onProfile != null) scope.Item("Open profile", Sym.person, onClick = onProfile)
            scope.Item("Remove", Sym.trash, destructive = true, onClick = onRemove)
        }
    }
}

@Composable
fun ChatScreen(userId: String, name: String, close: (() -> Unit)? = null) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val nav = LocalNav.current
    var chat by remember { mutableStateOf<ChatThread?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    var showProfile by remember { mutableStateOf(false) }
    val shownName = chat?.with?.name ?: name
    val hasProfile = chat?.with?.isDriver == true
    val messages = chat?.messages ?: emptyList()
    val list = rememberLazyListState()

    suspend fun load() {
        app.user?.id?.let { E2E.prepare(it) }
        try {
            val fresh: ChatThread = ApiClient.get("/api/messages/$userId")
            chat = fresh
            if ((fresh.messages ?: emptyList()).any { it.fromMe != true && it.readAt == null }) {
                attempt { ApiClient.call("POST", "/api/messages/$userId/read") }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.shown
        }
    }

    suspend fun send(again: Boolean = true) {
        val words = draft.trim().take(1000)
        if (words.isEmpty()) return
        // Nobody else can check a sealed message for abuse, so it's done here.
        if (MessageFilter.isBlocked(words)) {
            error = "That message has a word that isn’t allowed."
            return
        }
        val theirs = chat?.with?.publicKey ?: return
        sending = true
        error = null
        try {
            val (body, senderKey) = E2E.seal(words, theirs)
            val fresh: ChatThread = ApiClient.post("/api/messages/$userId", mapOf("body" to body, "senderKey" to senderKey, "toKey" to theirs))
            chat = fresh
            draft = ""
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.code == "key_changed" && again) {
                // They have a new phone: seal it again for that one.
                load()
                send(again = false)
            } else {
                error = e.shown
            }
        } catch (e: Exception) {
            error = e.shown
        } finally {
            sending = false
        }
    }

    LaunchedEffect(app.rev) { load() }
    // A chat on screen hears new messages right away.
    androidx.compose.runtime.DisposableEffect(Unit) {
        app.chatsOpen += 1
        onDispose { app.chatsOpen -= 1 }
    }
    LaunchedEffect(messages.lastOrNull()?.id) {
        if (messages.isNotEmpty()) list.animateScrollToItem(messages.size)
    }

    Screen(
        shownName,
        close = close,
        scroll = false,
        padding = PaddingValues(0.dp),
        // The top of the chat opens their profile, as in other chat apps. Only a driver has one.
        titleContent = {
            if (hasProfile) {
                Column(Modifier.clickable { showProfile = true }.semantics { contentDescription = "$shownName. Opens their profile" }) {
                    Text(shownName, style = T.headline, color = Theme.ink, maxLines = 1)
                    Text("Tap for their profile", style = T.caption2, color = Theme.faint)
                }
            } else {
                Text(shownName, style = T.headline, color = Theme.ink, maxLines = 1)
            }
        },
        actions = {
            PersonMenu(userId, shownName, offersChat = false, onRemoveChat = if (messages.isEmpty()) null else ({ confirmRemove = true }))
        },
    ) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = list,
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(12.dp)).padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Sym.lock, null, tint = Theme.muted, modifier = Modifier.size(14.dp))
                    Text("Only you and $shownName can read these messages. If one of you reports the other, this chat is added to the report.", style = T.caption, color = Theme.muted)
                }
            }
            items(messages, key = { it.id }) { message -> Bubble(message) }
        }
        val current = chat
        if (current != null) {
            Column(
                Modifier.fillMaxWidth().background(Theme.card).padding(horizontal = 12.dp, vertical = 8.dp).imePadding().then(if (LocalInSheet.current) Modifier else Modifier),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                error?.let { Text(it, style = T.footnote, color = Theme.danger) }
                if (current.canSend == true) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                        Box(Modifier.weight(1f).heightIn(min = 46.dp).background(Theme.soft, RoundedCornerShape(23.dp)).padding(horizontal = 16.dp, vertical = 12.dp)) {
                            DzField(draft, { draft = it }, "Message", filled = false, maxLines = 6, modifier = Modifier.semantics { contentDescription = "Message" })
                        }
                        val can = !sending && draft.isNotBlank()
                        Box(
                            Modifier.size(46.dp).background(if (can || sending) Theme.accent else Theme.line, CircleShape).clip(CircleShape).clickable(enabled = can) { scope.launch { send() } },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (sending) Spinner(Theme.onAccent) else Icon(Sym.arrowUp, "Send", tint = if (can) Theme.onAccent else Theme.faint)
                        }
                    }
                    current.messagesLeft?.let { left ->
                        Text(if (left == 1) "You can send 1 more before $shownName replies." else "You can send $left more before $shownName replies.", style = T.caption, color = Theme.faint)
                    }
                } else {
                    current.why?.let { LabelRow(Sym.hourglass, it, T.footnote, Theme.muted) }
                }
            }
        }
    }
    if (showProfile) DzSheet(onDismiss = { showProfile = false }) { NavStack { DriverProfileScreen(userId, close = { showProfile = false }) } }
    if (confirmRemove) {
        AskDialog(
            title = "Remove this chat?",
            message = removalNote(shownName),
            choices = listOf(
                Choice("Remove chat", destructive = true) {
                    scope.launch {
                        attempt { ApiClient.call("DELETE", "/api/messages/$userId") }
                        if (close != null) close() else nav?.pop()
                    }
                },
            ),
            onDismiss = { confirmRemove = false },
        )
    }
}

@Composable
private fun Bubble(message: ChatMessage) {
    val mine = message.fromMe == true
    val words = E2E.open(message)
    Column(
        Modifier.fillMaxWidth().padding(start = if (mine) 44.dp else 0.dp, end = if (mine) 0.dp else 44.dp),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        SelectionContainer {
            Text(
                words ?: "This message can’t be read on this phone.",
                style = if (words == null) T.subheadline.italic else T.body,
                color = if (mine) Theme.onAccent else Theme.ink,
                modifier = Modifier.background(if (mine) Theme.accent else Theme.soft, RoundedCornerShape(20.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        message.at?.let { Text(Fmt.time(it), style = T.caption2, color = Theme.faint) }
    }
}

// A round chat button that opens the conversation with someone.
@Composable
fun MessageButton(userId: String, name: String, big: Boolean = false) {
    var open by remember { mutableStateOf(false) }
    if (big) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).background(Theme.accentSoft, RoundedCornerShape(Theme.buttonRadius)).clip(RoundedCornerShape(Theme.buttonRadius)).clickable { open = true },
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Sym.chat, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
            Text("Message $name", style = T.subheadline.semibold, color = Theme.accentInk)
        }
    } else {
        Box(Modifier.size(46.dp).background(Theme.accentSoft, CircleShape).clip(CircleShape).clickable { open = true }.semantics { contentDescription = "Message $name" }, contentAlignment = Alignment.Center) {
            Icon(Sym.chat, null, tint = Theme.accentInk, modifier = Modifier.size(20.dp))
        }
    }
    if (open) {
        DzSheet(onDismiss = { open = false }) { NavStack { ChatScreen(userId, name, close = { open = false }) } }
    }
}
