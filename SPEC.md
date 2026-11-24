# Omnintent Rule Book v0.1

Status: experimental draft, November 2026. License: MIT. Copyright: Omnintent contributors.

This rule book defines `omnintent.json`, a single description of the actions an app offers to AI
agents, and the rules for turning it into platform integrations:

- **Siri** (Siri AI Developer Preview): App Intents marked as tools with `@AppIntent(.tool)`.
- **Android and Gemini**: AppFunctions (`androidx.appfunctions`, Android 16+).
- **Cloud agents** (Claude, ChatGPT, Gemini Spark, Meta Muse and other MCP hosts): an MCP server.

The format is **MCP tools, extended for phone apps**. An action is an MCP tool definition (`name`,
`title`, `description`, `inputSchema`, `outputSchema`, annotations derived from a safety level) plus
what phones need and MCP does not have: entities with privacy and authentication, confirmation
prompts, sample utterances, and a mapping to the developer's HTTP backend.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in BCP 14 (RFC 2119, RFC 8174)
when they appear in capitals.

Two kinds of conformance:

- A **conforming manifest** validates against `schema/omnintent.schema.json` and breaks no rule
  marked *error* below.
- A **conforming generator** implements the mappings in sections C and E. Where a platform cannot
  honour a rule (for example, it has no confirmation step), the generator MUST leave the action out
  for that platform rather than weaken the rule.

Rule IDs (`OI1xx`, `T00x`) are stable; `omnintent validate` and `omnintent test` report them.

---

## Contents

- [The file](#the-file)
- [A. Describing actions](#a-describing-actions)
- [B. Describing entities: privacy and authentication](#b-describing-entities-privacy-and-authentication)
- [C. Safety levels and confirmation](#c-safety-levels-and-confirmation)
- [D. Writing rules](#d-writing-rules)
- [E. Platform mappings](#e-platform-mappings)
- [F. Testing rules](#f-testing-rules)
- [G. Versioning](#g-versioning)
- [Rule index](#rule-index)

---

## The file

`omnintent.json` is a JSON object:

| Field | Required | Meaning |
| --- | --- | --- |
| `omnintent` | yes | Rule book version. MUST be `"0.1"`. |
| `app` | yes | `name`, `slug` (lowercase, used for package and worker names), `description`, optional `version`, `instructions`, `ios.bundleId`, `android.packageName`. |
| `actions` | yes | Array of actions (section A). At least one. |
| `entities` | no | Map from PascalCase name to entity (section B). |
| `backend` | no | The developer's HTTP API, needed for the MCP target (section E.4). |
| `skills` | no | Multi-step guidance that ties actions together (section A.6). |
| `$schema` | no | Path to the JSON Schema, for editors. |

Unknown fields are errors everywhere. Extension keywords inside JSON Schemas use the prefix
`x-omnintent-`, following MCP's own `x-mcp-header` convention.

`app.instructions` is app-level guidance for agents: the app's domain, the order in which actions
are usually combined, and constraints that span actions. It becomes the MCP server's
`instructions` and Android's `appfn:instructions`.

---

## A. Describing actions

An action is one thing a person can ask an agent to do in the app.

```json
{
  "name": "add_item",
  "title": "Add Item",
  "description": "Adds a new item to a to-do list and returns the created item.",
  "safety": "write",
  "inputSchema": {
    "type": "object",
    "properties": {
      "listId": { "type": "string", "title": "List", "description": "The ID of the list, for example \"groceries\".", "x-omnintent-entity": "TodoList" },
      "title": { "type": "string", "title": "Title", "description": "What needs to be done, for example \"Buy milk\".", "minLength": 1 }
    },
    "required": ["listId", "title"],
    "additionalProperties": false
  },
  "outputSchema": { "$ref": "#/entities/TodoItem" },
  "backend": { "method": "POST", "path": "/lists/{listId}/items" },
  "examples": [
    { "utterance": "Add milk to my groceries list", "arguments": { "listId": "groceries", "title": "milk" } },
    { "utterance": "Put \"file taxes\" on my work list", "arguments": { "listId": "work", "title": "file taxes" } }
  ]
}
```

### A.1 Identity

- `name` MUST be snake_case (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`) and unique in the manifest (OI101,
  OI102). It is the MCP tool name, and it becomes `AddItemIntent` in Swift and `addItem` in Kotlin.
  snake_case is stricter than MCP requires so that one name converts cleanly to every platform.
- `title` is a short Title Case label (at most 60 characters) that people see.
- `description` says what the action does (section D).

### A.2 Parameters: `inputSchema`

`inputSchema` is a JSON Schema 2020-12 object schema, the same as MCP's `inputSchema`. To map onto
Swift and Kotlin, v0.1 allows a subset at the top level of `properties`:

- `type`: `string`, `integer`, `number`, `boolean`, or `array` of one of these.
- `format` (strings): `date`, `date-time`, `uri`, `email`; `int64` on integers is a type hint for
  Kotlin and is removed from published schemas.
- `enum` (strings only), `default`, `examples`, `minimum`, `maximum`, `minLength`, `maxLength`,
  `minItems`, `maxItems`, `pattern`.
- Every parameter MUST have a `description` and SHOULD have a `title` (OI106).
- Parameter names MUST start with a letter and SHOULD be camelCase (OI150), because they become
  Swift and Kotlin identifiers.
- Parameter names MUST NOT invite an agent to send its whole context, for example `fullContext`,
  `conversationHistory` or `chatHistory` (OI150, error).
- `required` lists the parameters the action cannot run without; it MUST name defined parameters
  (OI123). A `default` on a required parameter is never used (OI151, warning).
- `additionalProperties` SHOULD be `false` (OI152), which MCP recommends for exact argument sets.
- Defaults on `date` and `date-time` parameters are not supported (OI151): resolve them in code.

**Entity IDs.** A string parameter with `"x-omnintent-entity": "TodoList"` holds the ID of that
entity (OI120, OI124). Siri receives the entity itself (and resolves it through the entity's query);
Android and MCP receive the ID string. Write the description about the ID ("The ID of the list…");
the Swift generator rewrites a leading "The ID of" to "The" for Siri.

### A.3 Results: `outputSchema`

One of:

- `{ "$ref": "#/entities/Name" }`: one entity.
- `{ "type": "array", "items": { "$ref": "#/entities/Name" } }`: a list of entities.
- `{ "type": "object", "properties": { … }, "required": [ … ] }`: a small result of scalar fields,
  using the same property keywords as entities (section B).
- Absent: the action returns nothing an agent needs.

References MUST resolve (OI120). Generators MUST inline references when they publish schemas.

### A.4 Safety, idempotency, reach

- `safety` is one of `read`, `write`, `destructive`, `payment` (section C). It is required.
- `idempotent: true` means calling twice with the same arguments has the same effect as calling once.
- `openWorld: true` means the action reaches people or systems outside the app (sends email, posts).
- `authentication` sets who must be present (section B.3).
- `confirmation` holds `prompt` (the question shown before the action runs, with optional `{param}`
  placeholders), optional `acceptLabel`, and for write actions `required: true` to opt in.

### A.5 Backend mapping

`backend` tells the MCP server how to call the developer's API (section E.4).

### A.6 Skills

A skill is guidance for a multi-step task, not a deterministic workflow:
`name` (lowercase letters, digits and hyphens), a one-line `description` (OI161), Markdown
`instructions`, and the `actions` it uses (OI162). Refer to actions informally ("the list items
tool"), as Apple advises for app skills. A platform receives a skill only if every action it lists is
available on that platform; a skill that mentions an action the agent cannot call would mislead it.

### A.7 Platform switches

`platforms.ios.enabled`, `platforms.android.enabled` and `platforms.mcp.enabled` include or exclude
the action per platform. Section C limits what can be enabled on Android. If an intent already
conforms to an Apple app schema in a Siri-supported domain, disable it for iOS here: Apple says such
intents MUST NOT also be marked as tools.

---

## B. Describing entities: privacy and authentication

An entity is a kind of thing the app knows about. It is a JSON Schema object with Omnintent
keywords:

```json
"TodoItem": {
  "type": "object",
  "title": "To-do Item",
  "description": "One task on a to-do list.",
  "privacy": "personal",
  "idProperty": "id",
  "displayProperty": "title",
  "properties": {
    "id": { "type": "string", "title": "ID", "description": "The unique ID of the item." },
    "title": { "type": "string", "title": "Title", "description": "What needs to be done." },
    "done": { "type": "boolean", "title": "Done", "description": "Whether the item is complete." },
    "notes": { "type": "string", "title": "Notes", "description": "Notes the app keeps for itself.", "visibility": "internal" }
  },
  "required": ["id", "title", "done"]
}
```

### B.1 Identity

- Entity names are PascalCase.
- `idProperty` and `displayProperty` MUST name required string properties (OI121). Agents use them
  to refer to the entity, so they MUST NOT be `internal` or `sensitive` (OI122).
- Properties use the parameter keywords of A.2 (scalars, enums and arrays of scalars in v0.1) and
  MUST have descriptions.

### B.2 Privacy and visibility

| Keyword | Values | Meaning |
| --- | --- | --- |
| `privacy` (entity or property) | `public` | Safe to show anyone. |
| | `personal` (default) | The user's own data. |
| | `sensitive` | Financial, health, credentials or similar. |
| `visibility` (property) | `public` (default), `internal` | `internal`: the app and its extensions may use it; agents never see it. |

A property's privacy defaults to its entity's. Rules:

- **Internal** properties MUST NOT reach any agent. Siri: declared with `visibility: .internal`.
  Android and MCP: left out of generated types and stripped from results.
- **Sensitive** properties MUST NOT be sent to off-device agents (MCP) or to Android agents.
  Android's guidelines say AppFunctions must not return financial details or similarly sensitive
  data. On Siri they stay, behind local-device authentication.
- Generated MCP servers return only the fields an output schema declares. Fields a backend adds later
  never leak by accident.

### B.3 Authentication levels

| Omnintent | Meaning | Siri (`IntentAuthenticationPolicy`) |
| --- | --- | --- |
| `none` | No check. | `.alwaysAllowed` |
| `authenticated` | The user must be authenticated (device unlocked). | `.requiresAuthentication` |
| `local-device` | The user must unlock the device that runs the action. | `.requiresLocalDeviceAuthentication` |

Derived levels, strictest wins:

- Entity: `authentication` if set, else from privacy (public: none, personal: authenticated,
  sensitive: local-device).
- Property: emitted on Siri only when stricter than its entity.
- Action: the strictest of the safety level's minimum (section C), the action's `authentication`, and
  the level of any entity it returns. Apple notes that per-property policies cover Siri's responses,
  not intent results, which is why returned entities raise the action's level. On **write** actions
  an explicit `authentication` replaces the safety minimum. On destructive and payment actions it can
  only raise it.

Android AppFunctions have no per-function authentication setting; the app enforces its own checks
in its handlers. MCP servers authenticate at the server level (section E.4).

---

## C. Safety levels and confirmation

| Level | Use for | Confirmation | MCP annotations | MCP server behaviour | Siri minimum authentication | Siri confirmation | Android |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read` | Returns data, changes nothing. | Never. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint` from `openWorld` | Calls the backend. | `none` | None. | Generated. |
| `write` | Creates or changes data; can be undone. | Optional: `confirmation.required: true`. | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint` from `idempotent`, `openWorldHint` from `openWorld` | If confirmation is required: elicit, else rely on the host. | `authenticated` (overridable) | If required: `requestConfirmation(actionName: .continue or .custom(…acceptLabel…, destructive: false), dialog:)` | Generated. If confirmation is required: opt-in only, generated with `isEnabled = false`. |
| `destructive` | Deletes or overwrites data, or cannot be undone. | Required, with a prompt (OI110). | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint` from `idempotent`, `openWorldHint` from `openWorld` | Elicit, else rely on the host. | `authenticated` | `requestConfirmation(actionName: .custom(acceptLabel: …, denyLabel: "Cancel", destructive: true), dialog:)` | Opt-in only (`platforms.android.enabled: true`), generated with `isEnabled = false`. |
| `payment` | Moves money or commits the user to a purchase. | Required, with a prompt (OI110). | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` | Elicit; refuse if the client cannot. | `local-device` | `requestConfirmation(actionName: .pay or .custom(…), dialog:)` | Never (OI140). |

When unsure between two levels, choose the stricter one.

**How each platform confirms.**

- **Siri.** The generated intent calls `requestConfirmation(conditions:actionName:dialog:)` (iOS 18+)
  before calling the handler. It returns if the person confirms and throws if they cancel.
  `ConfirmationActionName` has `.pay` but no delete name, so destructive actions use
  `.custom(acceptLabel:acceptAlternatives:denyLabel:denyAlternatives:destructive: true)`.
- **MCP.** Annotations are hints, and clients MUST treat them as untrusted unless the server is
  trusted. The MCP spec says hosts SHOULD keep a human in the loop and confirm sensitive operations.
  Omnintent servers also confirm themselves. On protocol 2026-07-28, when the request's declared
  client capabilities include `elicitation`, the server answers `tools/call` with an
  `input_required` result holding a form elicitation (`confirm: boolean`), and runs the action only
  when the retried call carries an accepted `confirm: true`. A decline returns a tool error and
  changes nothing. If the client cannot elicit (no capability, or a 2025-era client), destructive and
  write actions rely on the host's confirmation, which `destructiveHint` requests. Payment actions
  are refused.
- **Android.** AppFunctions give the app no confirmation step, and Google's quality guidelines say
  AppFunctions should perform only safe, non-destructive tasks the user could do in the app. So any
  action that must be confirmed is opt-in on Android and generated with `isEnabled = false`. The app
  enables it with `AppFunctionManager.setAppFunctionEnabled` only after its own consent flow. Payment
  actions are never generated.

**Confirmation prompts** are short questions that name what will happen ("Delete "{itemId}"
permanently?"). Placeholders MUST name input parameters (OI111). Siri fills an entity placeholder
with the entity's display property; MCP fills it with the argument value.

**Method sanity check (OI134, warning).** GET is expected to be `read` and DELETE `destructive`.
PUT and PATCH are expected to be `write` or `destructive`. POST may be anything.

---

## D. Writing rules

Agents choose actions and fill parameters from titles and descriptions alone. Apple, Google and the
MCP spec give overlapping advice; Omnintent adopts it as rules.

**Titles**

- Title Case, at most 60 characters, verb plus resource: "Add Item", "List To-do Lists" (OI103).

**Descriptions (actions)** — OI104, OI105, warnings

- Start with a third-person verb and the resource it acts on: "Adds…", "Lists…", "Deletes…".
- Say what the action returns and any conditional behaviour ("If `status` is omitted, returns open
  items").
- Put key information first; some agents do not read everything.
- Be neutral and descriptive. Do not command the model ("You MUST…"), do not use emphasis markup or
  capitals ("**CRITICAL**", "IMPORTANT"), and do not pad ("This function is used to…").
- Be accurate. A read action MUST NOT write; never describe more than the action does.
- Do not refer to other actions or tell the agent in which order to call them. Put cross-action
  guidance in `app.instructions` or a skill.
- Do not imitate another tool or app.

**Descriptions (parameters and properties)**

- Say what the value is, its unit or format, and a concrete example: "The day the item is due, as
  YYYY-MM-DD." The Kotlin generator appends `Example: …` values from the samples to KDoc `@param`
  tags.
- State defaults and limits in the parameter that has them.
- Name parameters after the data: `taskId`, `searchQuery`, `recipientEmail`.

**App instructions**

- Lead with the app's domain and what its actions cover.
- Then list operational patterns ("Use the list lists action to turn a list name into its ID…") and
  constraints that span actions.
- No marketing language, no personality prompts, no repetition of action descriptions.

**Sample utterances**: see section F.

---

## E. Platform mappings

### E.1 Fields

| Manifest | Swift (App Intents, Siri tools) | Kotlin (AppFunctions) | MCP |
| --- | --- | --- | --- |
| `app.name`, `app.version` | — | — | `serverInfo` name and version |
| `app.description` + `app.instructions` + platform skills | `Skills.skillsbundle/Skills/<name>/SKILL.md` per skill | `appfn:instructions` in `res/xml/app_metadata.xml` | server `instructions` |
| `app.android.packageName` | — | package `<pkg>.omnintent`; entry point `Base<App>AppFunctionService`; KSP generates `<App>AppFunctionService` | — |
| `actions[].name` | `struct <Name>Intent: AppIntent`; handler `func <name>(…)` | `suspend fun <name>(…)` in the entry point | tool `name` |
| `title` | `static let title: LocalizedStringResource` | (KDoc summary only) | tool `title` and `annotations.title` |
| `description` | `static let description = IntentDescription(…)` | KDoc summary; `@AppFunctionDeclaration(isDescribedByKDoc = true)` | tool `description` |
| `safety` | `@AppIntent(.tool)`; `static let authenticationPolicy`; `requestConfirmation` (section C) | generated, opt-in with `isEnabled = false`, or omitted (section C) | annotations and server-side confirmation (section C) |
| `idempotent`, `openWorld` | — | — | `idempotentHint`, `openWorldHint` |
| `authentication` | raises or sets `authenticationPolicy` | — (app enforces) | — (server-level auth) |
| `confirmation.prompt` | `dialog:` with `\(…)` interpolation | — | elicitation `message` |
| `inputSchema.properties.<p>` | `@Parameter(title:description:default:) var p` | function parameter with KDoc `@param p … Example: …` | `inputSchema.properties.p` |
| `required` | non-optional property | non-null parameter without default | `required` |
| optional, no default | `T?` | `T? = null` (collections: empty) | not required |
| `default` | `default:` argument | `T? = null`, resolved with `?: default` in the body | `default` |
| `enum` | generated `enum …: String, AppEnum` | `String` with `@AppFunctionStringValueConstraint(enumValues = […])` and a body check | `enum` |
| `x-omnintent-entity` | parameter typed `<Entity>Entity`; handler receives `.id` | `String` ID | `string` (keyword removed) |
| output: entity | `some IntentResult & ReturnsValue<<Entity>Entity>` | returns `@AppFunctionSerializable data class <Entity>` | `outputSchema` (entity schema), `structuredContent` |
| output: list | `ReturnsValue<[<Entity>Entity]>` | `List<<Entity>>` | `outputSchema` `{ "items": [ … ] }` wrapper |
| output: object | `struct <Action>Result: TransientAppEntity` | `data class <Action>Result` | `outputSchema` object |
| `entities.<E>` | `struct <E>Entity: AppEntity` with `@Property(title:description:…)`, `EnumerableEntityQuery` | `@AppFunctionSerializable(isDescribedByKDoc = true) data class <E>` with inline KDoc per property | inlined JSON Schema |
| entity `privacy`/`authentication` | `static let authenticationPolicy` | sensitive properties omitted | sensitive properties omitted |
| property `visibility: internal` | `@Property(…, visibility: .internal)` | omitted | omitted and stripped |
| property `sensitive` | `@Property(…, authenticationPolicy: .requiresLocalDeviceAuthentication)` | omitted | omitted and stripped |
| `examples` | Siri request list for SiriEvaluations (`omnintent test --plan`) | KDoc `Example:` values; adb commands (`--plan`) | test cases (`--plan`) |
| `backend` | — | — | HTTP proxy (E.4) |
| `platforms.<p>.enabled` | include or exclude | include or exclude (within section C) | include or exclude |

**Why lists are wrapped on MCP.** MCP 2026-07-28 allows any JSON value as structured content, but
earlier revisions required an object. Wrapping lists as `{ "items": [...] }` serves both.

### E.2 Types

| JSON Schema | Swift | Kotlin | MCP |
| --- | --- | --- | --- |
| `string` | `String` | `String` | `string` |
| `string`, `format: date` | `Date` | `java.time.LocalDate` | `string`, `format: date` |
| `string`, `format: date-time` | `Date` | `java.time.Instant` | `string`, `format: date-time` |
| `string`, `format: uri` | `URL` | `android.net.Uri` | `string`, `format: uri` |
| `string`, `format: email` | `String` | `String` | `string`, `format: email` |
| `string`, `enum` | generated `AppEnum` | `String` + `@AppFunctionStringValueConstraint` | `string`, `enum` |
| `integer` | `Int` | `Int` (`Long` with `format: int64`) | `integer` |
| `number` | `Double` | `Double` | `number` |
| `boolean` | `Bool` | `Boolean` | `boolean` |
| `array` of T | `[T]` | `List<T>`, or `IntArray`/`LongArray`/`DoubleArray`/`BooleanArray` | `array` |

Android delivers an omitted optional parameter as its type's empty value (null, zero, false or
empty), not the declared default. Generated Kotlin therefore declares optional scalars as nullable
and resolves manifest defaults in the function body.

### E.3 Handlers

Apple discovers App Intents at build time, so intent types cannot be created at runtime. The same
is true of AppFunctions, whose schema the KSP compiler generates. Generators therefore emit static
declarations that call developer code through a generated interface:

- Swift: `protocol OmnintentHandlers` (one method per action, plus `<e>Entities(for:)` and
  `all<E>Entities()` per entity), registered once at launch with `OmnintentRuntime.register(_:)`.
- Kotlin: `interface OmnintentHandlers`, supplied by the Application through
  `OmnintentHandlersProvider`. No dependency-injection framework is required. Handlers throw
  `AppFunctionInvalidArgumentException` or `AppFunctionElementNotFoundException` with plain-language
  messages.
- MCP: no handler code. The server calls the backend (E.4).

### E.4 Backend and the MCP server

```json
"backend": { "baseUrl": "<YOUR_BACKEND_URL>", "auth": { "type": "bearer", "secret": "BACKEND_TOKEN" }, "timeoutMs": 10000 }
```

Per action: `"backend": { "method": "POST", "path": "/lists/{listId}/items", "query": [...], "body": [...], "resultPointer": "/data" }`.

- `{name}` in `path` is replaced by the URL-encoded argument. Each placeholder MUST be a required
  parameter (OI130).
- Defaults: for GET and DELETE, the other arguments go to the query string; for POST, PUT and PATCH,
  they go to a JSON body. Explicit `query` and `body` lists override this. Names MUST be parameters,
  used once (OI131).
- `resultPointer` (RFC 6901) selects the result inside the response.
- Every MCP-enabled action MUST have a backend mapping when the manifest has a `backend` (OI132).
- The server validates arguments against `inputSchema` before calling the backend.
- A non-2xx response becomes a tool error (`isError: true`) with a short, safe message: 404 says
  "Not found", and 400 or 422 says the backend rejected the arguments.
- The server sends `Authorization: Bearer <secret>` when `auth.type` is `bearer`. The secret lives in
  the server's environment, never in the manifest. `BACKEND_BASE_URL` overrides `baseUrl` at runtime.
- **Inbound authentication.** v0.1 servers accept a pre-shared token: clients send
  `Authorization: Bearer <MCP_ACCESS_TOKEN>`. Without that secret, the server refuses every request
  unless `ALLOW_UNAUTHENTICATED=true`, which is meant for local development only. This is an API key,
  not MCP OAuth, and every caller acts as one backend account. Per-user access requires OAuth 2.1
  with PKCE and Protected Resource Metadata (RFC 9728), as the MCP authorization spec requires; it is
  planned, not generated, in v0.1.
- Transport: Streamable HTTP at `/mcp`, MCP revision 2026-07-28 (stateless), with stateless
  fallback for 2025-era clients.

---

## F. Testing rules

Every action ships with sample utterances and the arguments an agent should extract. They are the
shared test cases for all platforms.

```json
"examples": [
  { "utterance": "Add milk to my groceries list", "arguments": { "listId": "groceries", "title": "milk" } },
  { "utterance": "Put \"file taxes\" on my work list for 2027-04-15", "arguments": { "listId": "work", "title": "file taxes", "dueDate": "2027-04-15" } }
]
```

Static rules (checked by `omnintent validate` and `omnintent test`):

| Rule | Severity | Requirement |
| --- | --- | --- |
| OI107 | error | At least 2 examples per action. |
| OI108 | error | `arguments` validate against `inputSchema`. |
| OI109 | error | No utterance appears on two actions (an agent could not tell them apart); duplicates within an action are warnings. |
| T001 | error | Every required string argument appears word for word in its utterance (case and punctuation tolerant). Exemption: entity-ID parameters, which agents resolve from names. |
| T002 | warning | Enum values and optional non-string values appear in the utterance, or the agent can infer them. |
| T003 | warning | At least one example uses the optional parameters. |
| T005 | warning | Utterances of different actions are not near-duplicates (token overlap ≥ 0.75). |

Write utterances the way people talk ("What's on my groceries list?"), vary the phrasing, and cover
optional parameters.

Live testing uses the same cases. `omnintent test --plan <dir>` writes:

- `cases.json`: utterance, expected tool, expected arguments, safety.
- `siri-requests.md`: requests to script with Apple's SiriEvaluations framework.
- `adb-commands.sh`: `adb shell cmd app_function execute-app-function …` per Android function.

`--plan` also writes `siri/OmnintentSiriEvaluations.swift` (a SiriEvaluations scenario per sample),
`android/run-functions.sh` and `android/agent-checklist.md`, and a `results.json` template per
platform for recording what a device agent did.

`omnintent agent-test` runs the cases against a model acting as the agent. It sees the tools as a
host would (from a live MCP server's `tools/list`, or projected from the manifest for MCP, iOS or
Android). Read-only tools are called to answer lookups. The first call to any other tool is the
agent's decision and is recorded, never executed. A case passes when that decision names the
expected action with arguments that match `expectedArguments`: free text matches ignoring case,
quotes and trailing punctuation, an omitted argument may equal its default, and dates, numbers and
entity IDs must match exactly. When a platform does not expose the expected action (for example a
destructive action on Android), the case passes only if the agent makes no write call.

---

## G. Versioning

- `omnintent` holds the rule book version. v0.x is experimental: a 0.x minor version MAY change or
  remove rules. From 1.0, minor versions only add optional fields and warnings, and major versions
  may break.
- Tools MUST reject a manifest whose major version they do not know (and, during 0.x, an unknown
  minor version), rather than guess.
- Generated files carry a header naming the generator version. Generators MUST be deterministic:
  the same manifest and generator version produce byte-identical output.
- The platform APIs this version targets are previews or recent releases: Siri AI Developer Preview
  (APIs may change during the preview), `androidx.appfunctions` 1.0.0, and MCP 2026-07-28. A change
  in a platform API is a reason for a new rule book version, not a silent generator change.

---

## Rule index

| ID | Severity | Rule |
| --- | --- | --- |
| SCHEMA | error | The manifest validates against `schema/omnintent.schema.json`. |
| OI101 | error | Action names are unique. |
| OI102 | error | Action names are snake_case. |
| OI103 | warning | Titles start with a capital letter. |
| OI104 | warning | Descriptions start with a third-person verb, are long enough, and avoid commands, emphasis and filler. |
| OI105 | warning | Descriptions do not refer to other actions. |
| OI106 | warning | Parameters have titles. |
| OI107 | error | At least 2 sample utterances per action. |
| OI108 | error | Sample arguments validate against `inputSchema`. |
| OI109 | error/warning | Utterances are unique across actions (error) and within an action (warning). |
| OI110 | error | Destructive and payment actions have a confirmation prompt and cannot turn confirmation off. |
| OI111 | error | Prompt placeholders name input parameters. |
| OI112 | warning | Read actions ignore `confirmation`. |
| OI120 | error | Entity references resolve. |
| OI121 | error | `idProperty` and `displayProperty` are required string properties. |
| OI122 | error | `idProperty` and `displayProperty` are not internal or sensitive. |
| OI123 | error | `required` names defined properties. |
| OI124 | error | Entity-ID parameters are plain strings. |
| OI130 | error | Path placeholders are required parameters. |
| OI131 | error/warning | Query and body names are parameters used once; GET and DELETE bodies are warned. |
| OI132 | error | MCP-enabled actions have a backend mapping. |
| OI133 | warning | Without `backend`, the MCP target cannot be generated. |
| OI134 | warning | Safety level matches the HTTP method. |
| OI140 | error | Payment actions are never enabled on Android. |
| OI141 | warning | Opted-in Android actions that need confirmation are generated disabled. |
| OI150 | error/warning | Parameter names are not context dumps (error) and are camelCase (warning). |
| OI151 | error/warning | Formats, enums, arrays and defaults are consistent with types. |
| OI152 | warning | `inputSchema` sets `additionalProperties: false`. |
| OI160 | error | Skill names are unique. |
| OI161 | error | Skill descriptions are one line. |
| OI162 | error | Skills refer to existing actions. |
| OI171 | warning | `app.android.packageName` is set. |
| OI172 | warning | `backend.baseUrl` is a placeholder. |
| OI173 | error | `backend.baseUrl` is an http(s) URL or a placeholder. |
| T001–T005 | see section F | Sample utterance checks. |
