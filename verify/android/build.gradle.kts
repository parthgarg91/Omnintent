// Versions under test. KSP and AppFunctions must match the generator
// (packages/cli/src/generators/kotlin.ts); prepare.mjs checks KSP, and writes the
// AppFunctions version into each module. AGP 9 compiles Kotlin itself; the
// classpath entry pins the Kotlin version Google's AppFunctions sample uses.
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    id("com.android.application") version "9.5.1" apply false
    id("com.google.devtools.ksp") version "2.3.13" apply false
}
