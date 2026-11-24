package androidx.appfunctions

@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS)
annotation class AppFunctionServiceEntryPoint(val serviceName: String, val appFunctionXmlFileName: String)

@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.FUNCTION)
annotation class AppFunctionDeclaration(val isEnabled: Boolean = true, val isDescribedByKDoc: Boolean)

@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS)
annotation class AppFunctionSerializable(val isDescribedByKDoc: Boolean)

@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.PROPERTY, AnnotationTarget.FIELD)
annotation class AppFunctionStringValueConstraint(val enumValues: Array<String> = [])

abstract class AppFunctionService : android.app.Service()

open class AppFunctionException(message: String?) : Exception(message)

class AppFunctionInvalidArgumentException(message: String?) : AppFunctionException(message)

class AppFunctionElementNotFoundException(message: String?) : AppFunctionException(message)
