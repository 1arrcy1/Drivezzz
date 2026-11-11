package eu.drivezzz.app.ui

import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Draw
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ArrowBackIosNew
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Pets
import androidx.compose.material.icons.outlined.Star
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

// The icons, by what iOS calls them, so screens read the same on both. Nothing is drawn with a font that needs Apple's symbols.
object Sym {
    val car = Icons.Filled.DirectionsCar

    // A vehicle in a list, on a pin or a chip is a car from the side, as on iOS. Material has none, so it's drawn here.
    val carSide: ImageVector = ImageVector.Builder("carSide", 24.dp, 24.dp, 24f, 24f).addPath(
        addPathNodes(
            "M2.6 16.6C2 16.6 1.6 16.2 1.6 15.6V13.6C1.6 12.6 2.2 11.9 3.1 11.7L6 11L8.4 8.4C8.9 7.9 9.5 7.6 10.2 7.6H14.7" +
                "C15.5 7.6 16.2 7.9 16.7 8.5L18.7 11L20.9 11.6C21.8 11.9 22.4 12.6 22.4 13.6V15.6C22.4 16.2 22 16.6 21.4 16.6H20" +
                "A2.6 2.6 0 0 0 14.9 16.6H9.1A2.6 2.6 0 0 0 4 16.6Z" +
                "M7.9 11H11.6V9H10.2C9.9 9 9.7 9.1 9.5 9.3Z" +
                "M13 9V11H17L15.6 9.3C15.4 9.1 15.1 9 14.8 9Z" +
                "M6.55 15A1.95 1.95 0 1 0 6.55 18.9A1.95 1.95 0 1 0 6.55 15Z" +
                "M17.45 15A1.95 1.95 0 1 0 17.45 18.9A1.95 1.95 0 1 0 17.45 15Z",
        ),
        fill = SolidColor(Color.Black),
        pathFillType = PathFillType.EvenOdd,
    ).build()

    val motor = Icons.Filled.TwoWheeler
    // A kick scooter, as on iOS. Material's own is a moped.
    val scooter: ImageVector = ImageVector.Builder("scooter", 24.dp, 24.dp, 24f, 24f).apply {
        path(stroke = SolidColor(Color.Black), strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 3.5f)
            lineTo(14.8f, 3.5f)
            lineTo(17.7f, 15.6f)
            moveTo(8.6f, 18.2f)
            lineTo(12.8f, 18.2f)
            lineTo(16.9f, 13.6f)
            moveTo(8.6f, 18.2f)
            arcTo(2.6f, 2.6f, 0f, true, true, 3.4f, 18.2f)
            arcTo(2.6f, 2.6f, 0f, true, true, 8.6f, 18.2f)
            moveTo(20.9f, 18.2f)
            arcTo(2.6f, 2.6f, 0f, true, true, 15.7f, 18.2f)
            arcTo(2.6f, 2.6f, 0f, true, true, 20.9f, 18.2f)
        }
    }.build()
    fun vehicle(kind: String?) = when (kind) {
        "motor" -> motor
        "scooter" -> scooter
        else -> carSide
    }
    val map = Icons.Filled.Map
    val list = Icons.AutoMirrored.Filled.ListAlt
    val garage = Icons.Filled.Garage
    val chat = Icons.Filled.Forum
    val chatBubble = Icons.Outlined.ChatBubbleOutline
    val person = Icons.Filled.Person
    val people = Icons.Filled.Group
    val locationOff = Icons.Filled.LocationOff
    val filter = Icons.Filled.Tune
    val location = Icons.Filled.NearMe
    val pickup = Icons.Filled.EmojiPeople
    val rider = Icons.Filled.Hail
    val flag = Icons.Filled.Flag
    val flagOutline = Icons.Outlined.Flag
    val flagCheckered = Icons.Filled.SportsScore
    val circle = Icons.Filled.Circle
    val close = Icons.Filled.Close
    val check = Icons.Filled.Check
    val checkCircle = Icons.Filled.CheckCircle
    val checkShield = Icons.Filled.VerifiedUser
    val warnShield = Icons.Filled.GppMaybe
    val seal = Icons.Filled.Verified
    val back = Icons.Filled.ArrowBackIosNew
    val chevronRight = Icons.Filled.ChevronRight
    val arrowLeft = Icons.AutoMirrored.Filled.ArrowBack
    val arrowRight = Icons.AutoMirrored.Filled.ArrowForward
    val chevronUp = Icons.Filled.KeyboardArrowUp
    val chevronDown = Icons.Filled.KeyboardArrowDown
    val search = Icons.Filled.Search
    val clock = Icons.Filled.Schedule
    val recent = Icons.Filled.History
    val mapPin = Icons.Filled.Place
    val tap = Icons.Filled.TouchApp
    val calendar = Icons.Filled.CalendarMonth
    val bolt = Icons.Filled.Bolt
    val star = Icons.Filled.Star
    val starOutline = Icons.Outlined.Star
    val paw = Icons.Filled.Pets
    val pawOutline = Icons.Outlined.Pets
    val coin = Icons.Filled.CurrencyBitcoin
    val banknote = Icons.Filled.Payments
    val euro = Icons.Filled.Euro
    val minus = Icons.Filled.Remove
    val plus = Icons.Filled.Add
    val addCircle = Icons.Filled.AddCircle
    val info = Icons.Filled.Info
    val warning = Icons.Filled.Warning
    val alert = Icons.Filled.Error
    val lock = Icons.Filled.Lock
    val lockShield = Icons.Filled.Shield
    val undo = Icons.AutoMirrored.Filled.Undo
    val wallet = Icons.Filled.AccountBalanceWallet
    val link = Icons.Filled.Link
    val sync = Icons.Filled.Sync
    val refresh = Icons.Filled.Refresh // arrow.clockwise
    val send = Icons.AutoMirrored.Filled.Send
    val arrowUp = Icons.Filled.ArrowUpward
    val arrowOutUp = Icons.Filled.NorthEast
    val arrowInDown = Icons.Filled.SouthWest
    val openApp = Icons.AutoMirrored.Filled.OpenInNew
    val copy = Icons.Filled.ContentCopy
    val qr = Icons.Filled.QrCode2
    val sun = Icons.Filled.LightMode
    val sunHorizon = Icons.Filled.WbTwilight
    val moon = Icons.Filled.DarkMode
    val sleep = Icons.Filled.Bedtime
    val bookmark = Icons.Outlined.BookmarkBorder
    val bookmarkFill = Icons.Filled.Bookmark
    val pencil = Icons.Filled.Edit
    val trash = Icons.Filled.Delete
    val camera = Icons.Filled.CameraAlt
    val cameraOutline = Icons.Outlined.CameraAlt
    val eye = Icons.Filled.Visibility
    val more = Icons.Filled.MoreHoriz
    val block = Icons.Filled.PanTool
    val blocked = Icons.Filled.DoNotTouch
    val key = Icons.Filled.Key
    val help = Icons.AutoMirrored.Filled.HelpOutline
    val doc = Icons.Filled.Description
    val signature = Icons.Filled.Draw
    val code = Icons.Filled.Code
    val logout = Icons.AutoMirrored.Filled.Logout
    val bell = Icons.Filled.NotificationsActive
    val timer = Icons.Filled.Timer
    val hourglass = Icons.Filled.HourglassEmpty
    val route = Icons.Filled.Route
    val north = Icons.Filled.North
    val navigation = Icons.Filled.Navigation
    val turnSign = Icons.Filled.AltRoute
    val sum = Icons.Filled.Functions
    val radio = Icons.Filled.Sensors
    val badgeX = Icons.Filled.EventBusy
    val personCheck = Icons.Filled.HowToReg
    val idCard = Icons.Filled.Badge
    val sparkles = Icons.Filled.AutoAwesome
    val volumeOn = Icons.AutoMirrored.Filled.VolumeUp
    val volumeOff = Icons.AutoMirrored.Filled.VolumeOff
    // The driver checks.
    val creditCard = Icons.Filled.CreditCard
    val business = Icons.Filled.Business
    val cancel = Icons.Filled.Cancel
    val face = Icons.Filled.Face
    val viewfinder = Icons.Filled.DocumentScanner
    val docScan = Icons.Filled.DocumentScanner
    val photo = Icons.Filled.Photo
    val personQuestion = Icons.Filled.PersonSearch
    val nfc = Icons.Filled.Nfc
    val box = Icons.Filled.CheckBoxOutlineBlank
    val boxChecked = Icons.Filled.CheckBox

    // Turns, for the banner.
    val straight = Icons.Filled.North
    val slightLeft = Icons.Filled.NorthWest
    val slightRight = Icons.Filled.NorthEast
    val turnLeft = Icons.Filled.TurnLeft
    val turnRight = Icons.Filled.TurnRight
    val uTurn = Icons.Filled.UTurnLeft

    // A steering wheel: Material has none.
    val steering: ImageVector by lazy {
        ImageVector.Builder("steering", 24.dp, 24.dp, 24f, 24f).apply {
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.EvenOdd) {
                // The rim.
                moveTo(12f, 2f)
                arcTo(10f, 10f, 0f, true, true, 11.99f, 2f)
                close()
                moveTo(12f, 4.6f)
                arcTo(7.4f, 7.4f, 0f, true, false, 12.01f, 4.6f)
                close()
            }
            path(stroke = SolidColor(Color.Black), strokeLineWidth = 2.6f, strokeLineCap = StrokeCap.Round) {
                moveTo(4.5f, 11f)
                curveTo(8f, 10.2f, 16f, 10.2f, 19.5f, 11f)
                moveTo(12f, 12f)
                lineTo(12f, 20f)
            }
            path(fill = SolidColor(Color.Black)) {
                moveTo(12f, 9.2f)
                arcTo(3f, 3f, 0f, true, true, 11.99f, 9.2f)
                close()
            }
        }.build()
    }
}
