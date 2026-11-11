package eu.drivezzz.app.features

import eu.drivezzz.app.features.checks.TextReader

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Car
import eu.drivezzz.app.core.CarPhoto
import eu.drivezzz.app.core.DriverProfile
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.OwnDriverResponse
import eu.drivezzz.app.core.PlateCar
import eu.drivezzz.app.core.PlateLookup
import eu.drivezzz.app.core.Vehicle
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.capitalized
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

// A driver's own page: their vehicles (cars, motors, scooters), each with its own prices. The active one is what riders see and pay for.
@Composable
fun MyPageScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var bio by remember { mutableStateOf("") }
    var bioSaved by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showAddCar by remember { mutableStateOf(false) }
    var showPreview by remember { mutableStateOf(false) }
    var allowsPlanning by remember { mutableStateOf(false) }
    var planDays by remember { mutableIntStateOf(7) }
    val driver = app.driver

    LaunchedEffect(Unit) {
        app.loadDriver()
        bio = app.driver?.bio ?: ""
        allowsPlanning = app.driver?.allowsPlanning == true
        planDays = app.driver?.planDays ?: 7
    }

    fun savePlanning() {
        if (allowsPlanning == driver?.allowsPlanning && planDays == driver?.planDays) return
        scope.launch {
            try {
                val r: OwnDriverResponse = ApiClient.send("PATCH", "/api/driver", mapOf("allowsPlanning" to allowsPlanning, "planDays" to planDays))
                app.driver = r.driver
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
            }
        }
    }

    NavStack {
        val nav = LocalNav.current
        Screen("My page", large = true, spacing = 18.dp) {
            // Who you are to riders: your name, rating and how often you're on time.
            Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(62.dp).background(Theme.gradient, CircleShape), contentAlignment = Alignment.Center) {
                        Text((app.user?.name?.take(1) ?: "D").uppercase(), style = T.title.bold, color = Theme.onAccent)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(app.user?.name ?: "Driver", style = T.title2.bold, color = Theme.ink, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                            if (app.driver?.verified == true) VerifiedMark(20.dp)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Stars(kotlin.math.round(driver?.rating ?: 0.0).toInt(), 12.dp)
                            Text(Fmt.rating(driver?.rating, driver?.ratingCount), style = T.footnote, color = Theme.muted)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatTile(driver?.arrivalScore?.let { "$it%" } ?: "–", "On time")
                    StatTile(driver?.completedPercent?.let { "$it%" } ?: "–", "Completed")
                    StatTile(if (driver?.allowsPlanning == true) "${driver.planDays ?: 7} d" else "Off", "Planning")
                }
                PrimaryButton(height = 44.dp, color = Theme.accentSoft, textColor = Theme.accentInk, onClick = { showPreview = true }) {
                    Icon(Sym.eye, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
                    Text("See what riders see", style = T.size(17).semibold.kern(-0.2f), color = Theme.accentInk)
                }
            }
            // My vehicles
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("My vehicles", style = T.title3.bold, color = Theme.ink, modifier = Modifier.weight(1f))
                    Box(Modifier.clickable { showAddCar = true }) { LabelRow(Sym.plus, "Add", T.subheadline.semibold, Theme.accentInk) }
                }
                val cars = driver?.cars ?: emptyList()
                if (cars.isEmpty()) {
                    Column(
                        Modifier.fillMaxWidth().lifted(0.45f, 22.dp).background(Theme.card, RoundedCornerShape(22.dp)).clip(RoundedCornerShape(22.dp)).clickable { showAddCar = true }.padding(vertical = 26.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Sym.addCircle, null, tint = Theme.accentInk, modifier = Modifier.size(40.dp))
                        Text("Add a car, motor or scooter", style = T.headline, color = Theme.ink)
                        Text("Fill in the number plate and we look up the rest.", style = T.footnote, color = Theme.muted)
                    }
                }
                cars.forEach { car ->
                    CarRowCard(car, driver?.activeCarId == car.id, onOpen = { nav?.push { VehiclePage(car.id) } }, onActivate = {
                        error = null
                        scope.launch {
                            try {
                                val r: OwnDriverResponse = ApiClient.post("/api/cars/${car.id}/activate")
                                app.driver = r.driver
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.shown
                            }
                        }
                    })
                }
                if (cars.size > 1) Text("Riders see your active vehicle and pay its prices.", style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 4.dp))
            }
            error?.let { Text(it, style = T.footnote, color = Theme.danger, modifier = Modifier.padding(horizontal = 4.dp)) }
            // Planning
            Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("Planned rides", style = T.headline, color = Theme.ink)
                        Text(if (allowsPlanning) "Riders can book you for later. You can pass a drive on if you can’t make it." else "Riders can only book you for right now.", style = T.footnote, color = Theme.muted)
                    }
                    Spacer(Modifier.width(8.dp))
                    DzSwitch(allowsPlanning, "Planned rides") {
                        allowsPlanning = it
                        savePlanning()
                    }
                }
                if (allowsPlanning) {
                    Hairline()
                    Stepper(if (planDays == 1) "Up to 1 day ahead" else "Up to $planDays days ahead", planDays, 1..(driver?.maxPlanDays ?: 7)) {
                        planDays = it
                        savePlanning()
                    }
                }
            }
            // About
            Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("About you", style = T.headline, color = Theme.ink)
                DzField(bio, {
                    bio = it
                    bioSaved = it == (driver?.bio ?: "")
                }, "A little about you (optional)", minLines = 2, maxLines = 4)
                if (!bioSaved) {
                    PrimaryButton("Save", height = 44.dp, onClick = {
                        scope.launch {
                            try {
                                val r: OwnDriverResponse = ApiClient.send("PATCH", "/api/driver", mapOf("bio" to bio))
                                app.driver = r.driver
                                bioSaved = true
                                focus.clearFocus()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.shown
                            }
                        }
                    })
                }
            }
        }
    }
    if (showAddCar) DzSheet(onDismiss = { showAddCar = false }) { AddCarScreen { showAddCar = false } }
    if (showPreview) {
        val id = app.user?.id
        if (id != null) DzSheet(onDismiss = { showPreview = false }) { NavStack { DriverProfileScreen(id, close = { showPreview = false }) } }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CarRowCard(car: Car, active: Boolean, onOpen: () -> Unit, onActivate: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(22.dp)
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .lifted(0.45f, 22.dp)
                .background(Theme.card, shape)
                .border(2.dp, if (active) Theme.accent else Color.Transparent, shape)
                .clip(shape)
                .combinedClickable(onLongClick = { if (!active) menu = true }, onClick = onOpen)
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            VehicleThumb(car)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(car.title, style = T.headline, color = Theme.ink, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                    if (active) StatusPill("Active", Theme.ok, Theme.okSoft)
                }
                Text(car.shownPlate, style = T.footnote.mono.semibold, color = Theme.muted)
                Text("${Fmt.rate(car.perKmCents)}/km · ${Fmt.rate(car.perMinCents)}/min", style = T.footnote.semibold, color = Theme.accentInk)
                if (car.photosMissing?.isEmpty() == false) StatusPill("Photos needed", Theme.warn, Theme.warnSoft)
                car.hold?.let { if (it.plate) StatusPill("Plate under review") else StatusPill("Not cleared", Theme.warn, Theme.warnSoft) }
            }
            Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
        }
        androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Theme.card, shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp)) {
            MenuScope { menu = false }.Item("Drive with this one", Sym.checkCircle, onClick = onActivate)
        }
    }
}

private val carBodies = listOf("hatchback", "sedan", "estate", "suv", "mpv", "van")
private val carColours = listOf(
    "Black" to "#1C1C1E", "White" to "#F4F4F2", "Grey" to "#8A8D91", "Silver" to "#B8BBBF", "Blue" to "#1F4E9E", "Red" to "#B3202A", "Green" to "#2C6B47",
    "Yellow" to "#E6B422", "Orange" to "#D9711C", "Brown" to "#6B4A32", "Beige" to "#C8B898", "Purple" to "#5C3A82", "Pink" to "#D98BA6", "Cream" to "#E8E0C8",
)
private fun bodyName(body: String) = if (body == "suv" || body == "mpv") body.uppercase() else body.capitalized()
private fun euros(cents: Int?) = String.format(Locale.US, "%.2f", (cents ?: 0) / 100.0)
private fun cents(text: String): Int? = text.replace(",", ".").toDoubleOrNull()?.let { (it * 100).roundToInt() }

// A price in euros, on one row.
@Composable
private fun PriceRow(label: String, value: String, onChange: (String) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
        Text("€", style = T.subheadline, color = Theme.faint)
        Spacer(Modifier.width(4.dp))
        Box(Modifier.width(64.dp)) {
            androidx.compose.foundation.text.BasicTextField(
                value, onChange,
                singleLine = true,
                textStyle = T.subheadline.digits.copy(color = Theme.ink, textAlign = TextAlign.End),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Theme.accentInk),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
        }
    }
}

// What a car is, and what it costs: the same fields for adding and for editing.
class CarForm {
    var make by mutableStateOf("")
    var model by mutableStateOf("")
    var seats by mutableIntStateOf(4)
    var body by mutableStateOf("hatchback")
    var colorName by mutableStateOf("Grey")
    var perKm by mutableStateOf("")
    var perMin by mutableStateOf("")
    var pickup by mutableStateOf("")
    var pets by mutableStateOf(false)
}

@Composable
private fun ChoiceRow(label: String, value: String, options: List<Pair<String, String>>, onChange: (String) -> Unit) {
    MenuFrom({ open ->
        Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
            Text(options.firstOrNull { it.first == value }?.second ?: value, style = T.subheadline, color = Theme.muted)
            Icon(Sym.chevronDown, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
        }
    }) {
        options.forEach { (key, shown) -> Item(shown) { onChange(key) } }
    }
}

@Composable
private fun CarDetailsSection(kind: String, form: CarForm) {
    ListSection(if (kind == "car") "The car" else "The $kind") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            DzField(form.make, { form.make = it }, "Make", filled = false, style = T.subheadline)
            Hairline()
            DzField(form.model, { form.model = it }, "Model", filled = false, style = T.subheadline)
            Hairline()
            if (kind == "car") {
                Stepper(if (form.seats == 1) "1 passenger" else "${form.seats} passengers", form.seats, 1..16) { form.seats = it }
                Hairline()
                ChoiceRow("Body", form.body, carBodies.map { it to bodyName(it) }) { form.body = it }
            } else {
                LabeledRow("Passengers", "1")
            }
            Hairline()
            ChoiceRow("Colour", form.colorName, carColours.map { it.first to it.first }) { form.colorName = it }
        }
    }
}

@Composable
private fun CarPricesSection(form: CarForm) {
    ListSection("Prices for this vehicle", "An open market: riders see the cheapest first. Your way to the pickup counts in the price.") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PriceRow("Per km", form.perKm) { form.perKm = it }
            Hairline()
            PriceRow("Per minute", form.perMin) { form.perMin = it }
            Hairline()
            PriceRow("To the pickup, per km", form.pickup) { form.pickup = it }
            Hairline()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Pets allowed", style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
                DzSwitch(form.pets, "Pets allowed") { form.pets = it }
            }
        }
    }
}

@Composable
fun AddCarScreen(close: () -> Unit) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val form = remember { CarForm() }
    var kind by remember { mutableStateOf("car") }
    var plate by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<PlateCar?>(null) }
    var looked by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        // A new car starts with the prices of the car in use.
        val d = app.driver
        form.perKm = euros(d?.perKmCents)
        form.perMin = euros(d?.perMinCents)
        form.pickup = euros(d?.pickupPerKmCents)
        form.pets = d?.petsAllowed == true
    }

    fun lookup() {
        if (plate.length < 4) return
        working = true
        error = null
        val clean = plate.uppercase().filter { it.isLetterOrDigit() }
        scope.launch {
            try {
                val r: PlateLookup = ApiClient.get("/api/plates/$clean")
                found = if (r.found == true) r.car else null
                found?.let { c ->
                    kind = c.vehicle ?: kind
                    form.make = c.make ?: form.make
                    form.model = c.model ?: form.model
                    form.seats = c.seats ?: form.seats
                    form.body = c.body ?: form.body
                    form.colorName = c.colorName ?: form.colorName
                }
                looked = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
            }
            working = false
        }
    }

    Screen("Add a vehicle", close = close) {
        Segmented(Vehicle.all.map(Vehicle::name), Vehicle.all.indexOf(kind)) {
            kind = Vehicle.all[it]
            form.seats = if (kind == "car") max(form.seats, 4) else 1
        }
        ListSection(
            footer = when {
                !looked -> "Dutch plates are looked up in the RDW register. We make pictures of your vehicle from that."
                found != null -> null
                else -> "Not in the Dutch register. Fill it in yourself."
            },
        ) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    DzField(
                        plate, { plate = it }, "Number plate", filled = false, style = T.callout.mono,
                        keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                    )
                }
                TextAction("Look up", { lookup() }, enabled = !working && plate.length >= 4)
            }
        }
        if (looked && found != null) LabelRow(Sym.seal, "Found in the register", T.footnote, Theme.ok)
        if (looked) {
            CarDetailsSection(kind, form)
            CarPricesSection(form)
        }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        if (looked) {
            PrimaryButton("Add ${Vehicle.name(kind).lowercase()}", working = working, onClick = {
                val km = cents(form.perKm)
                val min = cents(form.perMin)
                val pick = cents(form.pickup)
                if (km == null || min == null || pick == null) {
                    error = "Fill in your prices as amounts, like 0.90."
                    return@PrimaryButton
                }
                working = true
                error = null
                val hex = carColours.firstOrNull { it.first == form.colorName }?.second ?: "#8A8D91"
                scope.launch {
                    try {
                        val r: OwnDriverResponse = ApiClient.post(
                            "/api/cars",
                            mapOf(
                                "vehicle" to kind, "plate" to plate, "make" to form.make, "model" to form.model, "seats" to form.seats, "body" to form.body,
                                "colorName" to form.colorName, "colorHex" to hex, "perKmCents" to km, "perMinCents" to min, "pickupPerKmCents" to pick, "petsAllowed" to form.pets,
                            ),
                        )
                        app.driver = r.driver
                        close()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            })
        }
    }
}

@Composable
fun EditCarScreen(initial: Car, close: () -> Unit) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var car by remember { mutableStateOf(initial) }
    val form = remember {
        CarForm().apply {
            make = initial.make ?: ""
            model = initial.model ?: ""
            seats = initial.seats ?: 4
            body = initial.body ?: "hatchback"
            colorName = initial.colorName ?: "Grey"
            perKm = euros(initial.perKmCents)
            perMin = euros(initial.perMinCents)
            pickup = euros(initial.pickupPerKmCents)
            pets = initial.petsAllowed == true
        }
    }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var photoKind by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val kind = photoKind
        photoKind = null
        if (uri == null || kind == null) return@rememberLauncherForActivityResult
        working = true
        error = null
        scope.launch {
            try {
                val jpeg = withContext(Dispatchers.IO) { shrink(context, uri) }
                if (jpeg == null) {
                    error = "That photo can’t be used."
                } else {
                    // A car's back: what's on it goes along, for the plate (checks.js). The photo counts, not the plate someone typed in.
                    var path = "/api/cars/${car.id}/photos?kind=$kind"
                    var plateRead = true
                    var headers = emptyMap<String, String>()
                    if (kind == "back" && car.kind == "car") {
                        val read = TextReader.lines(jpeg).joinToString("\n").take(1000)
                        path += "&read=" + android.net.Uri.encode(read)
                        plateRead = letters(read).contains(letters(car.plate))
                        // Signed, so the server knows this app read it (backPhotoRead in checks.js): a typed plate doesn't count.
                        headers = eu.drivezzz.app.features.checks.AppAttest.headers(listOf("drivezzz-plate-1", car.id, eu.drivezzz.app.features.checks.AppAttest.hash(read.toByteArray())), jpeg, app.user?.id)
                    }
                    val r: OwnDriverResponse = ApiClient.upload(path, jpeg, headers)
                    app.driver = r.driver
                    r.car?.let { car = it }
                    if (!plateRead) error = "The plate can’t be read in this photo. In the Netherlands a person then has to check it, so take one with the plate clearly in view."
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
            }
            working = false
        }
    }
    fun pick(kind: String) {
        photoKind = kind
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    val hex = carColours.firstOrNull { it.first == form.colorName }?.second ?: car.colorHex ?: "#8A8D91"
    val kindName = Vehicle.name(car.kind).lowercase()

    Screen(
        car.title,
        close = close,
        actions = {
            TextAction("Save", {
                val km = cents(form.perKm)
                val min = cents(form.perMin)
                val pick = cents(form.pickup)
                if (km == null || min == null || pick == null) {
                    error = "Fill in your prices as amounts, like 0.90."
                } else {
                    working = true
                    error = null
                    scope.launch {
                        try {
                            val r: OwnDriverResponse = ApiClient.send(
                                "PATCH", "/api/cars/${car.id}",
                                mapOf(
                                    "make" to form.make, "model" to form.model, "seats" to form.seats, "body" to form.body, "colorName" to form.colorName, "colorHex" to hex,
                                    "perKmCents" to km, "perMinCents" to min, "pickupPerKmCents" to pick, "petsAllowed" to form.pets,
                                ),
                            )
                            app.driver = r.driver
                            close()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                        working = false
                    }
                }
            }, enabled = !working)
        },
    ) {
        ListSection {
            Box(Modifier.padding(12.dp)) { CarGallery(car, 170.dp) }
            CardDivider(16.dp)
            ListRow { LabeledRow("Number plate", trailing = { PlateView(car.shownPlate, 15.dp) }) }
        }
        CarPricesSection(form)
        CarDetailsSection(car.kind, form)
        ListSection("Photos", "Riders see these. The front, the back${if (car.kind == "car") " and the inside" else ""} are needed before you can go online.") {
            PhotoSlot(car, "Front of the $kindName", "front") { pick("front") }
            CardDivider(16.dp)
            PhotoSlot(car, "Back of the $kindName", "back") { pick("back") }
            if (car.kind == "car") {
                CardDivider(16.dp)
                PhotoSlot(car, "Inside the car", "inside") { pick("inside") }
            }
            CardDivider(16.dp)
            ListRow(onClick = { pick("outside") }) { LabelRow(Sym.cameraOutline, "Add another photo", T.subheadline, Theme.accentInk) }
            (car.photos ?: emptyList()).filter { (it.kind ?: "") !in listOf("front", "back", "inside") }.forEach { photo ->
                CardDivider(16.dp)
                OtherPhotoRow(photo) {
                    scope.launch {
                        try {
                            val r: OwnDriverResponse = ApiClient.send("DELETE", "/api/car-photos/${photo.id}")
                            app.driver = r.driver
                            car = r.driver?.cars?.firstOrNull { it.id == car.id } ?: car
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                    }
                }
            }
        }
        if (working) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Spinner() }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        ListSection {
            ListRow(onClick = { confirmDelete = true }) { LabelRow(Sym.trash, "Delete $kindName", T.subheadline, Theme.danger) }
        }
    }
    if (confirmDelete) {
        AskDialog(
            title = "Delete this $kindName?",
            choices = listOf(
                Choice("Delete", destructive = true) {
                    scope.launch {
                        try {
                            val r: OwnDriverResponse = ApiClient.send("DELETE", "/api/cars/${car.id}")
                            app.driver = r.driver
                            close()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                    }
                },
            ),
            onDismiss = { confirmDelete = false },
        )
    }
}

// One of the required photos: tap to add it, or to replace it.
@Composable
private fun PhotoSlot(car: Car, title: String, kind: String, onClick: () -> Unit) {
    val photo = car.photos?.firstOrNull { it.kind == kind }
    ListRow(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(width = 64.dp, height = 44.dp).clip(RoundedCornerShape(8.dp)).background(Theme.accentSoft), contentAlignment = Alignment.Center) {
                if (photo != null) {
                    RemotePhoto(ApiClient.imageURL(photo.url), Modifier.fillMaxSize())
                } else {
                    Icon(Sym.cameraOutline, null, tint = Theme.accentInk, modifier = Modifier.size(20.dp))
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(title, style = T.subheadline, color = Theme.ink)
                Text(if (photo == null) "Tap to add" else "Tap to replace", style = T.caption, color = Theme.faint)
            }
            if (photo == null) StatusPill("Needed", Theme.warn, Theme.warnSoft) else Icon(Sym.checkCircle, null, tint = Theme.ok, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun OtherPhotoRow(photo: CarPhoto, remove: () -> Unit) {
    ListRow {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RemotePhoto(ApiClient.imageURL(photo.url), Modifier.size(width = 64.dp, height = 44.dp).clip(RoundedCornerShape(8.dp)))
            Text("Other", style = T.subheadline, color = Theme.muted, modifier = Modifier.weight(1f))
            Text("Remove", style = T.footnote.semibold, color = Theme.danger, modifier = Modifier.clickable(onClick = remove))
        }
    }
}

// At most 1400 px on the long side, the way it was taken, as a JPEG.
private fun shrink(context: Context, uri: Uri): ByteArray? = runCatching {
    val side = 1400
    val image = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
        val long = max(info.size.width, info.size.height)
        if (long > side) {
            val scale = side.toFloat() / long
            decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    ByteArrayOutputStream().use { out ->
        image.compress(Bitmap.CompressFormat.JPEG, 78, out)
        out.toByteArray()
    }
}.getOrNull()

// One of your vehicles, the way riders see it: pictures, prices, your rating and reviews. Edit is top right.
@Composable
fun VehiclePage(carId: String) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<DriverProfile?>(null) }
    var editing by remember { mutableStateOf<Car?>(null) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val car = app.driver?.cars?.firstOrNull { it.id == carId }
    val active = app.driver?.activeCarId == carId

    LaunchedEffect(app.user?.id) {
        app.user?.id?.let { id -> profile = attempt { ApiClient.get<DriverProfile>("/api/drivers/$id") } }
    }

    Screen(
        car?.title ?: "Vehicle",
        actions = { TextAction("Edit", { editing = car }) },
        bottom = if (car != null && !active) ({
            PrimaryButton("Drive with this one", working = working, onClick = {
                working = true
                error = null
                scope.launch {
                    try {
                        val r: OwnDriverResponse = ApiClient.post("/api/cars/$carId/activate")
                        app.driver = r.driver
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            })
        }) else null,
    ) {
        if (car == null) return@Screen
        Column(Modifier.fillMaxWidth().lifted(0.45f, 22.dp).background(Theme.card, RoundedCornerShape(22.dp))) {
            Box(Modifier.padding(10.dp)) { CarGallery(car, 210.dp) }
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(car.title, style = T.title2.bold, color = Theme.ink, maxLines = 1, modifier = Modifier.weight(1f))
                    if (active) StatusPill("Active", Theme.ok, Theme.okSoft)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    PlateView(car.shownPlate, 15.dp)
                    car.year?.let { Text("$it", style = T.subheadline, color = Theme.muted) }
                    if (car.verified == true) LabelRow(Sym.checkCircle, "Checked", T.footnote.semibold, Theme.ok)
                }
            }
        }
        // What still stops this car in the Netherlands (Pieter, 8 November 2026). Its plate waiting for a person: how long, and what the
        // driver can do meanwhile, as going online says it. Anything else: the RDW's word.
        car.hold?.let { hold ->
            if (hold.plate) {
                Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                        IconTile(Sym.hourglass)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text("Number plate under review", style = T.subheadline.bold, color = Theme.ink)
                            Text("${hold.text ?: "A person is checking this car’s number plate."} You’ll hear when it is. Meanwhile you can drive another vehicle that’s cleared, or take the back photo again.", style = T.footnote, color = Theme.muted)
                        }
                    }
                    GhostButton("Take the back photo again", onClick = { editing = car }, height = 42.dp)
                }
            } else if (hold.text != null) {
                NoteBox(Sym.alert, Theme.warn, Theme.warnSoft, "Can’t drive in the Netherlands yet: ${hold.text}")
            }
        }
        if (car.photosMissing?.isEmpty() == false) {
            NoteBox(Sym.camera, Theme.warn, Theme.warnSoft, "Add photos of the ${car.photosMissing.joinToString(", ")} before you can go online with this one.", Modifier.clickable { editing = car })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FactTile(Sym.vehicle(car.kind), Vehicle.name(car.kind), car.body?.let { if (it == "suv" || it == "mpv") it.uppercase() else it.capitalized() } ?: car.colorName ?: "")
            FactTile(Sym.people, "${car.seats ?: 1}", if ((car.seats ?: 1) == 1) "passenger" else "passengers")
            FactTile(Sym.paw, if (car.petsAllowed == true) "Yes" else "No", "pets")
        }
        Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Prices", style = T.headline, color = Theme.ink)
            Row(verticalAlignment = Alignment.CenterVertically) {
                PriceColumn(Fmt.rate(car.perKmCents), "per km")
                VerticalHairline()
                PriceColumn(Fmt.rate(car.perMinCents), "per minute")
                VerticalHairline()
                PriceColumn(Fmt.rate(car.pickupPerKmCents), "to pickup, km")
            }
            val km = car.perKmCents
            val min = car.perMinCents
            if (km != null && min != null) {
                Row(
                    Modifier.fillMaxWidth().background(Theme.accentSoft, RoundedCornerShape(12.dp)).padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Sym.sparkles, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
                    Text("A 10 km ride of 20 minutes: ${Fmt.eur(10 * km + 20 * min)}, plus your way to the pickup.", style = T.footnote, color = Theme.muted)
                }
            }
        }
        val d = app.driver
        Row(Modifier.fillMaxWidth().card(22.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(104.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(d?.rating?.let { String.format(Locale.US, "%.1f", it) } ?: "–", style = T.size(38).bold, color = Theme.ink)
                Stars(kotlin.math.round(d?.rating ?: 0.0).toInt(), 12.dp)
                Text(if (d?.ratingCount == 1) "1 review" else "${d?.ratingCount ?: 0} reviews", style = T.caption, color = Theme.faint)
            }
            Box(Modifier.width(0.5.dp).height(70.dp).background(Theme.line))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                LabeledRow("Rides", "${profile?.driver?.ridesDone ?: 0}")
                LabeledRow("Completed", d?.completedPercent?.let { "$it%" } ?: "–")
                LabeledRow("On time at the pickup", d?.arrivalScore?.let { "$it%" } ?: "–")
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("What riders say", style = T.headline, color = Theme.ink, modifier = Modifier.padding(horizontal = 4.dp))
            val list = (profile?.reviews ?: emptyList()).filter { it.stars != null }
            if (list.isEmpty()) {
                Text(if (profile == null) "Loading…" else "No reviews yet. They show here after your first rides.", style = T.subheadline, color = Theme.muted, modifier = Modifier.fillMaxWidth().card(22.dp))
            }
            list.take(20).forEach { r ->
                Column(Modifier.fillMaxWidth().card(22.dp, 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Stars(r.stars ?: 0)
                        Spacer(Modifier.weight(1f))
                        r.at?.let { Text(Fmt.dayMonth(it), style = T.caption, color = Theme.faint) }
                    }
                    if (!r.text.isNullOrEmpty()) Text(r.text, style = T.subheadline, color = Theme.ink)
                }
            }
        }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
    }
    editing?.let { c -> DzSheet(onDismiss = { editing = null }) { EditCarScreen(c) { editing = null } } }
}

// Before a driver's first time online: insurance and licences are the driver's, so the app says once that what the law asks where
// they drive is up to them. In some countries that's nothing; in others a licence, permits and insurance. The server keeps when.
@Composable
fun DriverRulesScreen(close: () -> Unit, seen: () -> Unit) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var working by remember { mutableStateOf(false) }
    Screen(
        "Before you drive",
        close = close,
        closeText = "Cancel",
        bottom = {
            PrimaryButton("Got it, go online", working = working, onClick = {
                working = true
                scope.launch {
                    app.rulesSeen()
                    working = false
                    close()
                    seen()
                }
            })
        },
    ) {
        HeroCard {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Sym.checkShield, null, modifier = Modifier.size(32.dp), tint = Theme.onAccent)
                Text("You drive for yourself", style = T.title2.bold, color = Theme.onAccent)
                Text("Drivezzz is at its core a marketplace and doesn’t take responsibility for your insurance or licences. We do check what we can against the sources that exist. Driving a car? Verify to get a blue check. Having what the law asks stays up to you.", style = T.subheadline, color = Theme.onAccent.copy(alpha = 0.9f))
            }
        }
        CardGroup("What you need", "A motor or scooter isn’t a taxi under Dutch law, so it needs no taxi permit or chauffeurskaart: the licence and insurance are still yours to have.") {
            RuleNeed(Sym.idCard, "A driving licence", "Valid for this vehicle.")
            CardDivider()
            RuleNeed(Sym.doc, "For a car: taxi permits", "A taxi permit from Kiwa, a chauffeurskaart and blue plates. We check them next.")
            CardDivider()
            RuleNeed(Sym.lockShield, "Insurance", "One that covers passengers who pay.")
            CardDivider()
            RuleNeed(Sym.car, "A safe vehicle", "Road-legal, and kept that way.")
        }
        Box(Modifier.fillMaxWidth().clickable { openUrl(context, "https://drivezzz.s3rver.nl/terms") }, contentAlignment = Alignment.Center) {
            Text("Read the terms", style = T.footnote.semibold, color = Theme.accentInk)
        }
    }
}

@Composable
private fun RuleNeed(symbol: androidx.compose.ui.graphics.vector.ImageVector, title: String, note: String) {
    Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconTile(symbol)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = T.subheadline.semibold, color = Theme.ink)
            Text(note, style = T.footnote, color = Theme.muted)
        }
    }
}

private fun letters(s: String) = s.uppercase().filter { it.isLetterOrDigit() }
