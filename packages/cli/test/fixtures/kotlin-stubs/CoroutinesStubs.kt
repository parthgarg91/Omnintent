package kotlinx.coroutines

import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

interface CoroutineScope

object Dispatchers {
    val IO: CoroutineContext = EmptyCoroutineContext
}

suspend fun <T> withContext(context: CoroutineContext, block: suspend CoroutineScope.() -> T): T =
    block(object : CoroutineScope {})
