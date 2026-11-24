// Test-only implementation for the field-notes fixture, which uses every
// parameter and result type the Kotlin generator can emit.
package com.example.fieldnotes.omnintent

import android.net.Uri
import java.time.Instant
import java.time.LocalDate

class FakeFieldNotesHandlers : OmnintentHandlers {
    override suspend fun logReading(
        label: String,
        count: Int,
        limit: Int,
        serial: Long,
        temperature: Double,
        humidity: Double?,
        verified: Boolean,
        urgent: Boolean?,
        day: LocalDate?,
        takenAt: Instant?,
        photo: Uri?,
        contact: String?,
        quality: String?,
        unit: String,
        tags: List<String>,
        samples: IntArray,
        serials: LongArray,
        weights: DoubleArray,
        flags: BooleanArray,
        days: List<LocalDate>,
        links: List<Uri>,
    ): LogReadingResult = LogReadingResult(readingId = "r-1", total = count, scores = samples, warnings = tags)

    override suspend fun getReading(readingId: String): Reading = Reading(id = readingId, label = "north creek", count = 3)

    override suspend fun listReadings(): List<Reading> = emptyList()

    override suspend fun syncNow() {}
}
