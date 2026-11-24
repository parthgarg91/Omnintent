// Compile-only stubs of the Android and AndroidX APIs that generated code uses.
// Signatures follow the public documentation of androidx.appfunctions 1.0.0
// (developer.android.com/ai/appfunctions); they are NOT the real library. The
// real AAR and android.jar are not reachable from this environment.
@file:Suppress("unused")

package android.content

abstract class Context {
    open val applicationContext: Context
        get() = this
}
