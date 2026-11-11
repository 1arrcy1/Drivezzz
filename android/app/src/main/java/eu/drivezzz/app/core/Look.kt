package eu.drivezzz.app.core

import java.util.Calendar
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tan

// The colour a rider or driver picks in Profile. It runs through the whole app: buttons, tabs, switches, segmented
// controls, icons, stars, the logo and loading screen, map pins and the route.
enum class AppAccent(val key: String, val shownName: String) {
    Blue("blue", "Blue"), Red("red", "Red"), Yellow("yellow", "Yellow");

    companion object {
        fun of(key: String?): AppAccent = entries.firstOrNull { it.key == key } ?: Blue
    }
}

// Automatic follows the sun where you are; Light and Dark stay as they are. Set in Profile.
enum class AppAppearance(val key: String, val shownName: String) {
    Auto("auto", "Automatic"), Light("light", "Light"), Dark("dark", "Dark");

    companion object {
        fun of(key: String?): AppAppearance = entries.firstOrNull { it.key == key } ?: Auto
    }
}

// Whether it's dark outside at a place, worked out on the phone from the sun's position (NOAA's formulas): nothing is asked of a
// server, and the far north's weeks of sun or dark just work. Dark starts a little after sunset, when it really gets dark.
object Sunlight {
    private const val DARK_BELOW = -3.0

    // The sun's height above the horizon, in degrees.
    fun elevation(atMs: Long, lat: Double, lng: Double): Double {
        val rad = Math.PI / 180
        val seconds = atMs / 1000.0
        val t = (seconds / 86400 + 2440587.5 - 2451545) / 36525
        val l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)).rem(360)
        val m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
        val e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
        val center = sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m * rad) * (0.019993 - 0.000101 * t) + sin(3 * m * rad) * 0.000289
        val omega = 125.04 - 1934.136 * t
        val longitude = l0 + center - 0.00569 - 0.00478 * sin(omega * rad)
        val obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * cos(omega * rad)
        val declination = asin(sin(obliquity * rad) * sin(longitude * rad))
        val y = tan(obliquity * rad / 2).pow(2)
        val equation = 4 / rad * (y * sin(2 * l0 * rad) - 2 * e * sin(m * rad) + 4 * e * y * sin(m * rad) * cos(2 * l0 * rad) -
            0.5 * y * y * sin(4 * l0 * rad) - 1.25 * e * e * sin(2 * m * rad))
        val minutes = (seconds / 60).rem(1440)
        val solar = (minutes + equation + 4 * lng).rem(1440)
        val hourAngle = (solar / 4 - 180) * rad
        val height = sin(lat * rad) * sin(declination) + cos(lat * rad) * cos(declination) * cos(hourAngle)
        return asin(max(-1.0, min(1.0, height))) / rad
    }

    fun isDark(atMs: Long, lat: Double, lng: Double): Boolean = elevation(atMs, lat, lng) < DARK_BELOW

    // Before the phone has ever known where it is: the clock has to do.
    fun isDarkByClock(): Boolean {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        return hour >= 20 || hour < 7
    }
}
