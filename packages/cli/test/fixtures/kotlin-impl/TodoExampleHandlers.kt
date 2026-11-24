// Test-only implementation of the generated handler interface for the to-do
// example. Compiling it proves the generated interface, data classes and
// provider can be implemented as documented.
package com.example.todoexample.omnintent

import android.app.Application
import java.time.LocalDate

class FakeTodoHandlers : OmnintentHandlers {
    override suspend fun listLists(): List<TodoList> = listOf(TodoList(id = "groceries", name = "Groceries", openCount = 1))

    override suspend fun addItem(listId: String, title: String, dueDate: LocalDate?): TodoItem =
        TodoItem(id = "item-9", listId = listId, title = title, done = false, dueDate = dueDate)

    override suspend fun listItems(listId: String, status: String): List<TodoItem> = emptyList()

    override suspend fun completeItem(itemId: String): TodoItem =
        TodoItem(id = itemId, listId = "groceries", title = "Buy milk", done = true)
}

class FakeApp : Application(), OmnintentHandlersProvider {
    override val omnintentHandlers: OmnintentHandlers = FakeTodoHandlers()
}

/** The KSP compiler normally generates this subclass from the entry point. */
class TodoExampleAppFunctionService : BaseTodoExampleAppFunctionService()
