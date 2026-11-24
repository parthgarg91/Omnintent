// Builds the Kotlin that Omnintent generates against the real androidx.appfunctions
// library and its KSP compiler. Run `node verify/android/prepare.mjs` first: it writes
// one Android app module per test manifest into modules/. See README.md.
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

rootProject.name = "omnintent-android-verify"

val modules = file("modules").listFiles { f -> f.isDirectory && f.resolve("build.gradle.kts").exists() }
    ?.sortedBy { it.name }
    .orEmpty()
check(modules.isNotEmpty()) { "No modules found. Run `node verify/android/prepare.mjs` first." }
for (dir in modules) {
    include(":${dir.name}")
    project(":${dir.name}").projectDir = dir
}
