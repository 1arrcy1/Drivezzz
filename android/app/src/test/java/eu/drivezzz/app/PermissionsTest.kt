package eu.drivezzz.app

import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import eu.drivezzz.app.core.Permissions
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

// Android drops a request made while another is open: the app's first start asks for location and notifications at once.
class PermissionsTest {
    private val asked = mutableListOf<List<String>>()
    private val launcher = object : ActivityResultLauncher<Array<String>>() {
        override val contract: ActivityResultContract<Array<String>, *> get() = error("not used")
        override fun launch(input: Array<String>, options: ActivityOptionsCompat?) { asked.add(input.toList()) }
        override fun unregister() {}
    }

    @Before
    fun fresh() {
        Permissions.launcher = null
        Permissions.answered()
        Permissions.launcher = launcher
    }

    @Test
    fun oneRequestAtATime() {
        Permissions.ask("location")
        Permissions.ask("notifications")
        assertEquals(listOf(listOf("location")), asked)
        Permissions.answered()
        assertEquals(listOf(listOf("location"), listOf("notifications")), asked)
        Permissions.answered()
        assertEquals(2, asked.size)
    }

    @Test
    fun theSameQuestionWaitsOnce() {
        Permissions.ask("location")
        Permissions.ask("notifications")
        Permissions.ask("notifications")
        Permissions.answered()
        Permissions.answered()
        assertEquals(2, asked.size)
    }

    @Test
    fun askedBeforeThereIsAScreenItWaitsForOne() {
        Permissions.launcher = null
        Permissions.ask("location")
        assertEquals(0, asked.size)
        Permissions.launcher = launcher
        assertEquals(listOf(listOf("location")), asked)
        Permissions.answered()
    }
}
