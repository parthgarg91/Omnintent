# Research notes

Gathered November 24, 2026, for Omnintent v0.1. Each source was read on that date unless a note
says otherwise. Platform APIs here are previews or new releases and will change. Re-check before
relying on any detail.

Apple documentation pages are fetched as Markdown by appending `.md` to the URL.

## Apple: Siri AI Developer Preview and App Intents

**[Bringing custom actions and content to Siri](https://developer.apple.com/documentation/AppIntents/bringing-custom-actions-and-content-to-siri.md)**

- `@AppIntent(.tool)` on an app intent adds `ToolIntent` conformance and makes it a tool Siri can call.
- If an intent already conforms to an app schema in a Siri-supported primary domain, do not add
  `.tool`. For schemas that support Shortcuts but not Siri, use `@AppIntent(.tool, schema: …)`.
- Intents that only configure (for example a `WidgetConfigurationIntent` without `perform()`) are
  not tools.
- Adding any tool intent makes the app's App Shortcuts unavailable to Siri. They stay available to
  Spotlight and the Action button, so tool intents must cover their functionality.
- Siri relies on the `title` and `description` of the intent and of each parameter. The doc's
  `AddToCart` example uses `@Parameter(title:description: LocalizedStringResource(...), default:)`.
- Entity properties take `description`, `authenticationPolicy` and `visibility` (`@Property`,
  `@DeferredProperty`, `@ComputedProperty`). Entities can declare a static `authenticationPolicy`.
  `visibility: .internal` hides a property from Siri and Shortcuts.
- A property-level policy covers only Siri's responses; an intent that returns sensitive data needs
  an intent-level policy.
- Generable entities: `@AppEntity(.generable)` on a `TransientAppEntity`, with generable property
  types.
- Siri finds entities through Spotlight, or else an `EnumerableEntityQuery` or a
  `DynamicOptionsProvider`.
- Verification: the AppIntentsTesting framework, the Siri Integration Advisor in Xcode, and the
  SiriEvaluations framework, which scripts requests to Siri.

**[Siri AI Developer Preview](https://developer.apple.com/documentation/appintents/siri-ai-developer-preview.md)**

- Available on iOS, iPadOS, macOS and visionOS on Apple Intelligence devices, in supported regions.
  The App Intents API and Siri behaviour may change during the preview.
- Works in development builds and internal TestFlight only. It is not available to external testers
  or App Store builds.
- Requests need not mention the app while it is in the foreground, has a Live Activity, or is part
  of an ongoing Siri conversation. In the background, requests must mention the app.

**[Orchestrating complex actions with app skills](https://developer.apple.com/documentation/AppIntents/orchestrating-complex-actions-with-app-skills.md)**

- One `Skills.skillsbundle` per app target, in Copy Bundle Resources, laid out as
  `Skills/<name>/SKILL.md`.
- Front matter: `name` (1–64 characters: lowercase letters, digits and hyphens, matching the folder
  name) and a one-line `description` (at most 1,024 characters). The body is at most 10,000 characters.
- A subset of the Agent Skills format with no other front-matter fields or supporting files.
- Skills guide Siri but do not make it deterministic. Refer to intents informally ("call the get
  weather tool").

**API reference**

- [`AppIntent`](https://developer.apple.com/documentation/appintents/appintent.md): `static var authenticationPolicy`,
  the `requestConfirmation` family, and `openAppWhenRun` (deprecated).
- [`requestConfirmation(conditions:actionName:dialog:)`](https://developer.apple.com/documentation/appintents/appintent/requestconfirmation(conditions:actionname:dialog:).md):
  iOS 18+. It returns when the person confirms and throws when they cancel.
- [`ConfirmationActionName`](https://developer.apple.com/documentation/appintents/confirmationactionname.md):
  `.add`, `.buy`, `.pay`, `.send`, `.share`, `.continue` and others, but no delete action. Use
  `.custom(acceptLabel:acceptAlternatives:denyLabel:denyAlternatives:destructive:)`.
- [`ConfirmationConditions`](https://developer.apple.com/documentation/appintents/confirmationconditions.md):
  `.lowConfidenceSource`.
- [`IntentAuthenticationPolicy`](https://developer.apple.com/documentation/appintents/intentauthenticationpolicy.md):
  `.alwaysAllowed`, `.requiresAuthentication`, `.requiresLocalDeviceAuthentication`.
- [`IntentDialog`](https://developer.apple.com/documentation/appintents/intentdialog.md): conforms
  to `ExpressibleByStringInterpolation`, so `dialog: "Delete \(item.title)?"` is valid.
- [`TransientAppEntity`](https://developer.apple.com/documentation/appintents/transientappentity.md):
  requires `init()`; not queried.

**[App Store Connect: platform version information](https://developer.apple.com/help/app-store-connect/reference/platform-version-information)**
(read for the submission helper)

- App Review "Notes": "The Notes field can contain up to 4000 bytes."
- "Description" and "What's New in this Version" are each limited to 4000 characters.

## Android: AppFunctions

**[AppFunctions overview](https://developer.android.com/ai/appfunctions)**

- An on-device equivalent of MCP tools: Android 16 (API 36) and later. Callers need
  `EXECUTE_APP_FUNCTIONS`, which only authorised system assistants get. The page labels the feature
  an experimental preview.
- Gemini integration requires the Connected Apps Platform developer preview. Testers use an
  "Android MCP connected app" in Google Connected Console.
- `adb shell cmd app_function list-app-functions --package <pkg>` lists the functions an app
  registered.

**[Add AppFunctions to your app](https://developer.android.com/ai/appfunctions/add-appfunctions)**

- Needs `compileSdk` 37 or higher and Android Gradle Plugin 9.1.0 or higher. The page's snippet shows
  `1.0.0-rc01`.
- `@AppFunctionServiceEntryPoint(serviceName, appFunctionXmlFileName)` goes on an abstract
  `AppFunctionService`. KSP generates the concrete service and the schema XML. The service and the
  `app_metadata` property are registered in the manifest.
- `isDescribedByKDoc` has had no default since 1.0.0-beta01, so it must be set explicitly.
- Kotlin default values do not apply when an agent calls a function. An omitted optional parameter
  arrives as `null`, `0`, `false` or empty. Resolve defaults in the body.
- Uncaught exceptions reach the agent as `AppFunctionAppUnknownException`. Throw specific
  `AppFunctionException` subclasses instead.
- `adb shell "cmd app_function execute-app-function --package … --function '<class>#<method>' --parameters '{…}'"`
  runs one function directly.

**[Jetpack release notes](https://developer.android.com/jetpack/androidx/releases/appfunctions)**

- **1.0.0 stable: November 18, 2026** (rc01 November 4, beta01 October 21, alpha13 October 7).
- Coordinates: `androidx.appfunctions:appfunctions:1.0.0` and, for KSP,
  `androidx.appfunctions:appfunctions-compiler:1.0.0`. There is also
  `androidx.appfunctions:appfunctions-testing:1.0.0`.
- Renames:
  - alpha13: `@AppFunction` became `@AppFunctionDeclaration`.
  - beta01: `appfn:description` became `appfn:instructions` in app metadata, "to align with MCP
    naming".
  - alpha10: `@AppFunctionServiceEntryPoint` replaced `AppFunctionConfiguration`.

**[Quality guidelines](https://developer.android.com/ai/appfunctions/quality-guidelines)**

- Expose only safe, non-destructive tasks the user would do in the app. Do not require or return
  passwords, financial details or other highly sensitive data. Do not act beyond the request.
- Descriptions:
  - Lead with a verb and a resource, front-load key information, and stay neutral.
  - No "You MUST", no `**CRITICAL**`, no filler such as "This function is used to".
  - No procedural instructions involving other functions.
- Parameters:
  - Use specific names; never `full_context` or `conversation_history`, which risk exfiltration.
  - Prefer `LocalDate`, `Instant` and `Uri`.
  - Only nullable, primitive, list and array types can be optional.

**[Android AppFunctions agent skill](https://github.com/android/skills/tree/main/device-ai/appfunctions)** (official Google repository)

- Supported types:
  - `Int`, `Long`, `Float`, `Double`, `Boolean`, and their primitive arrays.
  - `String`, `PendingIntent`, `Uri`, `LocalTime`, `LocalDate`, `LocalDateTime`, `Instant`,
    `ZoneId`.
  - `@AppFunctionSerializable` classes, and `List` of non-primitive supported types.
- Hilt is recommended but not required. A service-locator approach through `applicationContext` is
  documented.
- Declare a single entry point: before Android "Cinnamon Bun", only one service per app may handle
  the AppFunctionService action.
- KSP reads only inline KDoc on each property of a serializable class, not class-level `@param`.
- Only the summary, `@param` and `@return` reach agents; `@throws` does not.

**[AppFunctions sample](https://github.com/android/appfunctions)**

- Built with AGP 9.5.1, Kotlin 2.4.21, KSP 2.3.13 and appfunctions 1.0.0-rc01.
- Uses `@AppFunctionStringValueConstraint(enumValues = [...])` on parameters.
- Confirms sends with a two-step pattern: a preview function returns an A2UI component, then a
  separate function sends.
- Its `app_metadata.xml` still uses `appfn:description`, which beta01 renamed; Omnintent follows the
  release notes and uses `appfn:instructions`.

## Model Context Protocol

**[Specification, latest](https://modelcontextprotocol.io/specification/latest)**

- The latest revision is **2026-07-28**.
- Requests are stateless and self-contained, with per-request capability negotiation.
- Every request carries `_meta` keys `io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientCapabilities` and (SHOULD) `io.modelcontextprotocol/clientInfo`.

**[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)**

- A tool has `name`, `title`, `description`, `icons`, `inputSchema` (JSON Schema, 2020-12 by
  default), `outputSchema` and `annotations`.
- Names SHOULD be 1–128 characters from `A-Z a-z 0-9 _ - .` and unique per server.
- For tools with no parameters, `{"type": "object", "additionalProperties": false}` is recommended.
- `structuredContent` may be any JSON value, including arrays, when it conforms to `outputSchema`.
  It SHOULD also be serialised in a text block.
- Tool execution errors use `isError: true` (useful for model self-correction); protocol errors use
  JSON-RPC errors.
- Clients MUST treat annotations as untrusted unless the server is trusted. There SHOULD be a human
  in the loop able to deny invocations. Clients SHOULD confirm sensitive operations.
- A server may answer `tools/call` with `resultType: "input_required"` and `inputRequests` (for
  example `elicitation/create` in form mode). The client retries with `inputResponses`. This is
  multi round-trip requests (MRTR).

**[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)**

- One POST endpoint. The 2026-07-28 revision removed the GET stream and protocol-level sessions.
- `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers.
- Servers MUST validate `Origin`, and SHOULD bind to localhost when local.
- Server-to-client requests travel only as MRTR input requests. There is a defined fallback for 2025
  clients.

**[Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)**

- OAuth 2.1. MCP servers MUST publish Protected Resource Metadata (RFC 9728).
- Client ID Metadata Documents are a SHOULD; Dynamic Client Registration is deprecated.
- PKCE and Resource Indicators (RFC 8707). Servers MUST validate the token audience and MUST NOT pass
  tokens through.

**TypeScript SDK** ([npm](https://www.npmjs.com/package/@modelcontextprotocol/server), checked with `npm view`)

- Split v2 packages: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0
  (October 23, 2026). The legacy `@modelcontextprotocol/sdk` is 1.32.2.
- v2 server API, read from its type declarations:
  - `createMcpHandler(factory, options)` serves 2026-07-28 and falls back to stateless serving for
    2025-era traffic.
  - `fromJsonSchema(schema)` uses a plain JSON Schema as a tool's input or output schema.
  - `inputRequired`, `inputRequired.elicit`, `acceptedContent` and `inputResponse` implement MRTR.
  - `CLIENT_CAPABILITIES_META_KEY` reads the per-request capabilities.
  - Validation is AJV on Node and `@cfworker/json-schema` on workerd.
- v2 client: `versionNegotiation` defaults to `legacy` and can be pinned to `2026-07-28`. It
  fulfils `input_required` automatically through registered `elicitation/create` handlers.

## Cloudflare

- **[MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/index.md)**
  - `createMcpHandler` from `agents/mcp/server`: stateless, one server per request, built from a
    factory. Options include `route`, `corsOptions`, `allowedHostnames`, `allowedOriginHostnames`,
    `authContext` and `legacy`.
  - It uses `@modelcontextprotocol/server` (SDK v2), an optional peer dependency.
  - The Agents SDK skill recommends `createMcpHandler` over the deprecated `McpAgent` for new
    servers.
- **[Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/index.md)**:
  in the legacy stateless fallback, GET and DELETE return 405 and pushed elicitation fails. Use
  `inputRequired(...)` instead.
- **[Securing MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/index.md)**
  - `@cloudflare/workers-oauth-provider` with `OAuthAuthorizationServer`, `OAuthResourceServer` and
    `completeAuthorization()`.
  - A consent flow (`beginConsent`, `approveConsent`), and PKCE for upstream providers.
  - `requiredScopes` is advertised but not enforced.
  - Never log or return upstream tokens.
- npm on the same day: `agents` 0.34.0 (peers: `@modelcontextprotocol/server` 2.4.0), `wrangler`
  4.167.0, `@cloudflare/workers-types` 5.20261124.1, `@cloudflare/workers-oauth-provider` 1.3.0.
- **`@cloudflare/workers-oauth-provider` 1.3.0** (npm, published November 23, 2026; read from its
  README, `docs/` and type declarations in the package):
  - Two shapes: split `OAuthAuthorizationServer` + `OAuthResourceServer` (recommended for several
    resources) and the combined `OAuthProvider` (one Worker that is both). Omnintent uses the
    combined one: one Worker, one deploy.
  - `resourceMetadata.resource` must be an absolute URL (`http` only on loopback), fixed when the
    provider is built. The provider publishes RFC 9728 metadata at
    `/.well-known/oauth-protected-resource/<path>`, sends the `401` challenge, and binds every token
    to that one resource (RFC 8707).
  - Consent helpers: `describeConsent`, `beginConsent`, `approveConsent`, `denyConsent`,
    `isConsentRemembered`. Third-party sign-in: `beginUpstream` (only after consent) and
    `finishUpstream`. The consent page itself is the application's, and must escape client data.
  - `requiredScopes` is advertised, not enforced; `insufficientScope()` builds the `403` step-up.
  - `tokenExchangeCallback` can refresh an upstream token and set `accessTokenTTL`; throwing
    `invalid_grant` revokes the grant.
  - CIMD needs `clientIdMetadataDocumentEnabled` and the `global_fetch_strictly_public` flag. DCR is
    deprecated in MCP 2026-07-28 but still supported. A KV namespace bound as `OAUTH_KV` is required.
  - The package imports `cloudflare:workers`, so the Node adapter stubs that module.

## Anthropic API (for `omnintent discover`)

- [Messages API](https://platform.claude.com/docs/en/api/messages) (docs.claude.com redirects here):
  `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version` and
  `content-type`. Structured output goes in `output_config.format = {type: "json_schema", schema}`.
- [Versioning](https://platform.claude.com/docs/en/api/versioning): `anthropic-version: 2026-10-21`
  is recommended. Among its changes, `temperature`, `top_p` and `top_k` are rejected.
- [Models](https://platform.claude.com/docs/en/about-claude/models/overview): `claude-opus-5-5`
  (Claude Opus 5.5), with 128K maximum output.
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs):
  - `output_config.format` needs no beta header; the old `output_format` parameter is deprecated.
  - Objects need `additionalProperties: false`, so free-form maps are impossible.
  - `minimum`, `maxLength` and similar constraints are not supported.
  - There are complexity limits.

## Expo

- [expo-app-intents](https://docs.expo.dev/versions/latest/sdk/app-intents/): "App Intents differ
  from most Expo APIs because Apple discovers them at build time." "You cannot create App Intent
  types dynamically from JavaScript at runtime."
- Swift `perform()` methods dispatch invocations to JavaScript handlers.
- The package is in alpha. The page does not state a license.
- Omnintent adopts the lesson (generate static declarations, route invocations to handlers) and no
  code.

## Cloud agents: what was and was not verified

- **Meta Muse.** Source: [parallel.ai article](https://parallel.ai/articles/meta-muse-custom-integrations.md),
  third-party and vendor-written, about September 2026.
  - The Muse app connects to remote Streamable HTTP MCP servers and asks whether a server needs "an
    API key or header". Muse Code supports OAuth 2.1 login.
  - Approval policies (read-only, approve each action, allow) exist.
  - The brief's "OAuth with PKCE" was not confirmed by this source. Meta's own documentation was not
    read.
- **Gemini Spark.** Source: [Flowith article](https://flowith.io/blog/gemini-spark-connected-apps-mcp-guide/),
  third-party, August 2, 2026.
  - Users add a custom MCP server URL in the Gemini web app.
  - Write actions from custom apps currently need manual confirmation.
  - Google's own help page was not read.
- **OpenAI ChatGPT.** The help article "Developer mode and MCP apps in ChatGPT"
  (help.openai.com/en/articles/12584461) appeared in search results, but fetching it failed. Nothing
  about ChatGPT ("dots" or developer mode) was verified first-hand.

## How these notes are kept current

The watcher agent (`omnintent watch`, run weekly by `.github/workflows/watcher.yml`) reads the
version facts above straight out of this file and compares them with npm, the Jetpack release notes
and the MCP docs configuration. It also compares the Apple, Android, MCP and Cloudflare pages above
with its last snapshot (`docs/watch-state.json`). When something moves it opens an issue; a
maintainer re-reads the source and updates this file with the new date.

## Environment facts that shaped verification

- Google Maven (`dl.google.com`) is blocked by this environment's egress policy (HTTP 403), so the
  real `androidx.appfunctions` AAR could not be downloaded.
- No Swift toolchain is available.
- Kotlin 2.4.21 came from GitHub releases.
- `tree-sitter-swift` came from npm.
- See LIMITATIONS.md.
