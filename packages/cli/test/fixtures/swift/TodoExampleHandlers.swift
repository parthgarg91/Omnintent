// A minimal OmnintentHandlers implementation for the todo example, used only to check that the
// generated protocol can be implemented and the generated types constructed.

import Foundation

struct TodoExampleHandlers: OmnintentHandlers {
    func listLists() async throws -> [TodoListEntity] {
        [TodoListEntity(id: "groceries", name: "Groceries", openCount: 2)]
    }

    func addItem(listId: String, title: String, dueDate: Date?) async throws -> TodoItemEntity {
        TodoItemEntity(id: "1", listId: listId, title: title, done: false, dueDate: dueDate)
    }

    func listItems(listId: String, status: ListItemsStatus) async throws -> [TodoItemEntity] {
        switch status {
        case .open, .all:
            return [TodoItemEntity(id: "1", listId: listId, title: "Buy milk", done: false)]
        case .done:
            return []
        }
    }

    func completeItem(itemId: String) async throws -> TodoItemEntity {
        TodoItemEntity(id: itemId, listId: "groceries", title: "Buy milk", done: true, notes: "kept private")
    }

    func deleteItem(itemId: String) async throws {}

    func shareList(listId: String, email: String) async throws -> ShareListResult {
        ShareListResult(shareUrl: URL(string: "https://example.com/s/\(listId)")!, sharedWith: email)
    }

    func todoListEntities(for ids: [String]) async throws -> [TodoListEntity] {
        try await listLists().filter { ids.contains($0.id) }
    }

    func allTodoListEntities() async throws -> [TodoListEntity] {
        try await listLists()
    }

    func todoItemEntities(for ids: [String]) async throws -> [TodoItemEntity] {
        []
    }

    func allTodoItemEntities() async throws -> [TodoItemEntity] {
        []
    }
}

func registerTodoExampleHandlers() {
    OmnintentRuntime.register(TodoExampleHandlers())
}
