// Test-only implementation for the opt-in variant (delete_item and share_list
// enabled on Android). Exercises Unit returns and URI-typed results.
package com.example.optin.omnintent

import android.net.Uri
import java.time.LocalDate

class FakeOptInHandlers : OmnintentHandlers {
    override suspend fun listLists(): List<TodoList> = emptyList()

    override suspend fun addItem(listId: String, title: String, dueDate: LocalDate?): TodoItem =
        TodoItem(id = "item-9", listId = listId, title = title, done = false, dueDate = dueDate)

    override suspend fun listItems(listId: String, status: String): List<TodoItem> = emptyList()

    override suspend fun completeItem(itemId: String): TodoItem =
        TodoItem(id = itemId, listId = "groceries", title = "Buy milk", done = true)

    override suspend fun deleteItem(itemId: String) {}

    override suspend fun shareList(listId: String, email: String): ShareListResult =
        ShareListResult(shareUrl = Uri.parse("http://localhost:8788/shared/$listId"), sharedWith = email)
}
