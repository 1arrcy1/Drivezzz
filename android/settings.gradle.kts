pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "drivezzz"
include(":app")
// Only for tests on an emulator: a stand-in for a wallet app, see fakewallet/src. Never shipped.
include(":fakewallet")
