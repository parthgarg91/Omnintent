package android.net

abstract class Uri {
    companion object {
        fun parse(uriString: String): Uri = object : Uri() {
            override fun toString(): String = uriString
        }
    }
}
