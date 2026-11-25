// Swift target: App Intents marked as Siri tools (Siri AI Developer Preview).
// One file per action, one per entity, a runtime file with the handler
// protocol, and an app skills bundle. Apple discovers App Intents at build
// time, so everything here is static code that calls developer handlers.

import type { Action, AuthLevel, Entity, EntityProperty, Manifest, ParameterSchema, ValueSchema } from "../manifest.js";
import { enumCaseName, pascalCase, camelCase, swiftIdent, swiftString, stripIdSuffix, commentText, titleCase } from "../naming.js";
import { SAFETY, actionAuth, authForPrivacy, confirmationPrompt, entityAuth, isEnabledFor, maxAuth, needsConfirmation, skillsFor } from "../safety.js";
import { outputShape } from "../schema.js";
import { HEADER, fillTemplate, lines, type GeneratedFile } from "./types.js";

const ROOT = "OmnintentGenerated";

const AUTH_SWIFT: Record<AuthLevel, string> = {
  none: ".alwaysAllowed",
  authenticated: ".requiresAuthentication",
  "local-device": ".requiresLocalDeviceAuthentication",
};

export function generateSwift(manifest: Manifest): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const entities = manifest.entities ?? {};
  const actions = manifest.actions.filter((a) => isEnabledFor(a, "ios"));

  files.push({ path: `${ROOT}/OmnintentRuntime.swift`, content: runtimeFile(manifest, actions) });
  for (const [name, entity] of Object.entries(entities)) {
    files.push({ path: `${ROOT}/Entities/${name}Entity.swift`, content: entityFile(name, entity) });
  }
  for (const action of actions) {
    files.push({ path: `${ROOT}/Intents/${pascalCase(action.name)}Intent.swift`, content: intentFile(manifest, action) });
  }
  for (const skill of skillsFor(manifest, "ios")) {
    files.push({ path: `Skills.skillsbundle/Skills/${skill.name}/SKILL.md`, content: skillFile(skill) });
  }
  files.push({ path: "README.md", content: readme(manifest, actions) });
  return files;
}

// ---------------------------------------------------------------- types

function scalarType(type: string, format: string | undefined): string {
  if (type === "string") {
    if (format === "date" || format === "date-time") return "Date";
    if (format === "uri") return "URL";
    return "String";
  }
  if (type === "integer") return "Int";
  if (type === "number") return "Double";
  return "Bool";
}

/** Swift type of a value schema; enums use the provided generated enum name. */
function valueType(schema: ValueSchema, enumName: string): string {
  if (schema.type === "array") {
    const items = schema.items!;
    return `[${items.enum ? enumName : scalarType(items.type, items.format)}]`;
  }
  if (schema.enum) return enumName;
  return scalarType(schema.type, schema.format);
}

function enumValues(schema: ValueSchema): string[] | undefined {
  return schema.type === "array" ? schema.items?.enum : schema.enum;
}

function enumDecl(name: string, title: string, values: string[]): string {
  const cases = values.map((v) => {
    const c = enumCaseName(v);
    return c.replace(/`/g, "") === v ? `    case ${c}` : `    case ${c} = ${swiftString(v)}`;
  });
  const reps = values.map((v) => `        .${enumCaseName(v)}: ${swiftString(titleCase(v) || v)},`);
  return lines([
    `enum ${name}: String, AppEnum {`,
    ...cases,
    "",
    `    static let typeDisplayRepresentation: TypeDisplayRepresentation = ${swiftString(title)}`,
    `    static let caseDisplayRepresentations: [${name}: DisplayRepresentation] = [`,
    ...reps,
    "    ]",
    "}",
  ]);
}

function swiftDefault(schema: ValueSchema): string | undefined {
  const v = schema.default;
  if (v === undefined) return undefined;
  if (enumValues(schema) && !Array.isArray(v)) return `.${enumCaseName(String(v))}`;
  if (schema.type === "string" && schema.format === "uri") return undefined;
  if (typeof v === "string") return swiftString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => (enumValues(schema) ? `.${enumCaseName(String(x))}` : typeof x === "string" ? swiftString(x) : String(x)));
    return `[${items.join(", ")}]`;
  }
  return undefined;
}

// ---------------------------------------------------------------- runtime

interface HandlerParam {
  label: string;
  type: string;
  /** Expression passed from the intent's perform(). */
  argument: string;
}

interface IntentParam {
  name: string;
  schema: ParameterSchema;
  swiftName: string;
  propertyType: string;
  defaultValue?: string;
  enumName?: string;
  entity?: string;
  handler: HandlerParam;
}

function intentParams(manifest: Manifest, action: Action): IntentParam[] {
  const required = new Set(action.inputSchema.required ?? []);
  return Object.entries(action.inputSchema.properties ?? {}).map(([name, schema]) => {
    const entity = schema["x-omnintent-entity"];
    const isRequired = required.has(name);
    const enumName = enumValues(schema) ? `${pascalCase(action.name)}${pascalCase(name)}` : undefined;
    const defaultValue = isRequired ? undefined : swiftDefault(schema);
    if (entity && manifest.entities?.[entity]) {
      const swiftName = swiftIdent(stripIdSuffix(name));
      const base = `${entity}Entity`;
      return {
        name,
        schema,
        swiftName,
        entity,
        propertyType: isRequired ? base : `${base}?`,
        handler: {
          label: swiftIdent(name),
          type: isRequired ? "String" : "String?",
          argument: isRequired ? `${swiftName}.id` : `${swiftName}?.id`,
        },
      };
    }
    const base = valueType(schema, enumName ?? "");
    const optional = !isRequired && defaultValue === undefined;
    const swiftName = swiftIdent(name);
    return {
      name,
      schema,
      swiftName,
      enumName,
      defaultValue,
      propertyType: optional ? `${base}?` : base,
      handler: { label: swiftIdent(name), type: optional ? `${base}?` : base, argument: swiftName },
    };
  });
}

function resultTypeName(action: Action): string {
  return `${pascalCase(action.name)}Result`;
}

function handlerReturnType(action: Action): string | undefined {
  const shape = outputShape(action);
  switch (shape.kind) {
    case "none":
      return undefined;
    case "entity":
      return `${shape.entity}Entity`;
    case "entityList":
      return `[${shape.entity}Entity]`;
    case "object":
      return resultTypeName(action);
  }
}

function handlerSignature(manifest: Manifest, action: Action): string {
  const params = intentParams(manifest, action).map((p) => `${p.handler.label}: ${p.handler.type}`);
  const ret = handlerReturnType(action);
  return `func ${camelCase(action.name)}(${params.join(", ")}) async throws${ret ? ` -> ${ret}` : ""}`;
}

function runtimeFile(manifest: Manifest, actions: Action[]): string {
  const entityNames = Object.keys(manifest.entities ?? {});
  const actionReqs = actions.flatMap((a) => [`    /// ${commentText(a.description)}`, `    ${handlerSignature(manifest, a)}`, ""]);
  const entityReqs = entityNames.flatMap((n) => {
    const title = manifest.entities![n].title;
    return [
      `    /// Returns the ${commentText(title)} entities with the given IDs. Siri calls this to resolve parameters.`,
      `    func ${camelCase(n)}Entities(for ids: [String]) async throws -> [${n}Entity]`,
      "",
      `    /// Returns the ${commentText(title)} entities Siri may suggest. Index large sets in Spotlight instead.`,
      `    func all${n}Entities() async throws -> [${n}Entity]`,
      "",
    ];
  });
  return lines([
    `// ${HEADER}`,
    "",
    "import AppIntents",
    "import Foundation",
    "",
    "/// The app code that performs each action. Implement it once and register it",
    "/// at launch with `OmnintentRuntime.register(_:)`.",
    "protocol OmnintentHandlers: Sendable {",
    ...[...actionReqs, ...entityReqs].slice(0, -1),
    "}",
    "",
    "/// Holds the registered handlers. Generated intents and entity queries read from here.",
    "enum OmnintentRuntime {",
    "    private static let storage = OmnintentHandlerStorage()",
    "",
    "    /// Call once at app launch, before any intent runs.",
    "    static func register(_ handlers: any OmnintentHandlers) {",
    "        storage.set(handlers)",
    "    }",
    "",
    "    static func handlers() throws -> any OmnintentHandlers {",
    "        guard let handlers = storage.get() else {",
    "            throw OmnintentError.handlersNotRegistered",
    "        }",
    "        return handlers",
    "    }",
    "}",
    "",
    "/// Lock-protected storage, so registration is safe under Swift 6 strict concurrency.",
    "private final class OmnintentHandlerStorage: @unchecked Sendable {",
    "    private let lock = NSLock()",
    "    private var current: (any OmnintentHandlers)?",
    "",
    "    func set(_ handlers: any OmnintentHandlers) {",
    "        lock.lock()",
    "        defer { lock.unlock() }",
    "        current = handlers",
    "    }",
    "",
    "    func get() -> (any OmnintentHandlers)? {",
    "        lock.lock()",
    "        defer { lock.unlock() }",
    "        return current",
    "    }",
    "}",
    "",
    "enum OmnintentError: Error, CustomLocalizedStringResourceConvertible {",
    "    case handlersNotRegistered",
    "",
    "    var localizedStringResource: LocalizedStringResource {",
    "        switch self {",
    "        case .handlersNotRegistered:",
    `            return ${swiftString(`${manifest.app.name} is not ready to handle this request yet.`)}`,
    "        }",
    "    }",
    "}",
  ]);
}

// ---------------------------------------------------------------- entities

function propertyAttribute(prop: EntityProperty, title: string, entityLevel: AuthLevel | undefined): string {
  const args = [`title: ${swiftString(prop.title ?? title)}`, `description: ${swiftString(prop.description)}`];
  const own = prop.authentication ?? (prop.privacy ? authForPrivacy(prop.privacy) : undefined);
  if (own && entityLevel !== undefined && maxAuth(own, entityLevel) !== entityLevel) {
    args.push(`authenticationPolicy: ${AUTH_SWIFT[own]}`);
  }
  if (prop.visibility === "internal") args.push("visibility: .internal");
  return `@Property(${args.join(", ")})`;
}

interface PropModel {
  name: string;
  swiftName: string;
  type: string;
  optional: boolean;
}

function propertyBlock(
  typePrefix: string,
  props: [string, EntityProperty][],
  required: Set<string>,
  entityLevel: AuthLevel | undefined,
): { decls: string[]; enums: string[]; models: PropModel[] } {
  const decls: string[] = [];
  const enums: string[] = [];
  const models: PropModel[] = [];
  for (const [name, prop] of props) {
    const enumName = enumValues(prop) ? `${typePrefix}${pascalCase(name)}` : "";
    if (enumName) enums.push(enumDecl(enumName, prop.title ?? titleCase(name), enumValues(prop)!));
    const base = valueType(prop, enumName);
    const optional = !required.has(name);
    const swiftName = swiftIdent(name);
    decls.push(`    ${propertyAttribute(prop, titleCase(name), entityLevel)}`, `    var ${swiftName}: ${base}${optional ? "?" : ""}`, "");
    models.push({ name, swiftName, type: base, optional });
  }
  return { decls, enums, models };
}

function initializer(params: PropModel[], assignments: string[]): string[] {
  const sig = params.map((p) => `${p.swiftName}: ${p.type}${p.optional ? "? = nil" : ""}`).join(", ");
  return [`    init(${sig}) {`, ...assignments.map((a) => `        ${a}`), "    }"];
}

function entityFile(name: string, entity: Entity): string {
  const required = new Set(entity.required ?? []);
  const level = entityAuth(entity);
  const idName = entity.idProperty;
  const others = Object.entries(entity.properties).filter(([n]) => n !== idName);
  const block = propertyBlock(name, others, required, level);
  const idSwift = swiftIdent(idName);
  const params: PropModel[] = [{ name: idName, swiftName: idSwift, type: "String", optional: false }, ...block.models];
  const assignments = params.map((p) => `self.${p.swiftName} = ${p.swiftName}`);
  return lines([
    `// ${HEADER}`,
    "",
    "import AppIntents",
    "import Foundation",
    "",
    `/// ${commentText(entity.description)}`,
    `struct ${name}Entity: AppEntity {`,
    `    static let typeDisplayRepresentation: TypeDisplayRepresentation = ${swiftString(entity.title)}`,
    `    static let defaultQuery = ${name}EntityQuery()`,
    `    static let authenticationPolicy: IntentAuthenticationPolicy = ${AUTH_SWIFT[level]}`,
    "",
    `    /// ${commentText(entity.properties[idName].description)}`,
    `    let ${idSwift}: String`,
    idName !== "id" && "",
    idName !== "id" && `    var id: String { ${idSwift} }`,
    "",
    ...block.decls,
    "    var displayRepresentation: DisplayRepresentation {",
    // A bare "\\(name)" literal is inferred as String and fails to compile; the
    // title initializer takes a LocalizedStringResource (checked with Xcode 26.6).
    `        DisplayRepresentation(title: "\\(${swiftIdent(entity.displayProperty)})")`,
    "    }",
    "",
    ...initializer(params, assignments),
    "}",
    "",
    `/// Lets Siri find ${commentText(entity.title)} entities through your handlers.`,
    `struct ${name}EntityQuery: EnumerableEntityQuery {`,
    `    func entities(for identifiers: [${name}Entity.ID]) async throws -> [${name}Entity] {`,
    `        try await OmnintentRuntime.handlers().${camelCase(name)}Entities(for: identifiers)`,
    "    }",
    "",
    `    func allEntities() async throws -> [${name}Entity] {`,
    `        try await OmnintentRuntime.handlers().all${name}Entities()`,
    "    }",
    "}",
    ...block.enums.flatMap((e) => ["", e.trimEnd()]),
  ]);
}

// ---------------------------------------------------------------- intents

function siriParamDescription(param: IntentParam): string {
  if (!param.entity) return param.schema.description;
  return param.schema.description.replace(/^the (unique )?id of (the )?/i, "The ");
}

/** A Swift string literal with \(...) interpolations for {param} placeholders. */
function interpolated(template: string, params: IntentParam[], manifest: Manifest): string {
  const byName = new Map(params.map((p) => [p.name, p]));
  const marker = "\u0000";
  const pieces: string[] = [];
  const text = fillTemplate(template, (name) => {
    pieces.push(name);
    return marker;
  });
  const statics = text.split(marker).map((s) => swiftString(s).slice(1, -1));
  let out = statics[0];
  pieces.forEach((name, i) => {
    const p = byName.get(name)!;
    let expr: string;
    if (p.entity) {
      const display = swiftIdent(manifest.entities![p.entity].displayProperty);
      expr = p.propertyType.endsWith("?") ? `${p.swiftName}?.${display} ?? ""` : `${p.swiftName}.${display}`;
    } else if (p.propertyType === "String") {
      expr = p.swiftName;
    } else if (p.propertyType === "String?") {
      expr = `${p.swiftName} ?? ""`;
    } else {
      expr = `String(describing: ${p.swiftName})`;
    }
    out += `\\(${expr})` + statics[i + 1];
  });
  return `"${out}"`;
}

function parameterDecl(p: IntentParam): string[] {
  const args = [
    `title: ${swiftString(p.schema.title ?? titleCase(p.name))}`,
    `description: LocalizedStringResource(${swiftString(siriParamDescription(p))})`,
  ];
  if (p.defaultValue !== undefined) args.push(`default: ${p.defaultValue}`);
  return [`    @Parameter(${args.join(", ")})`, `    var ${p.swiftName}: ${p.propertyType}`, ""];
}

function intentFile(manifest: Manifest, action: Action): string {
  const typeName = `${pascalCase(action.name)}Intent`;
  const params = intentParams(manifest, action);
  const shape = outputShape(action);
  const ret = handlerReturnType(action);
  const resultClause = ret ? `some IntentResult & ReturnsValue<${ret}>` : "some IntentResult";
  const call = params.length
    ? [
        `OmnintentRuntime.handlers().${camelCase(action.name)}(`,
        ...params.map((p, i) => `    ${p.handler.label}: ${p.handler.argument}${i < params.length - 1 ? "," : ""}`),
        ")",
      ]
    : [`OmnintentRuntime.handlers().${camelCase(action.name)}()`];

  const body: string[] = [];
  if (needsConfirmation(action)) {
    const rule = SAFETY[action.safety];
    body.push(
      "try await requestConfirmation(",
      `    actionName: ${rule.siriActionName(action.confirmation?.acceptLabel)},`,
      `    dialog: ${interpolated(confirmationPrompt(action), params, manifest)}`,
      ")",
    );
  }
  if (ret) {
    body.push(`let result = try await ${call[0]}`, ...call.slice(1), "return .result(value: result)");
  } else {
    body.push(`try await ${call[0]}`, ...call.slice(1), "return .result()");
  }

  const enums = params
    .filter((p) => p.enumName)
    .map((p) => enumDecl(p.enumName!, p.schema.title ?? titleCase(p.name), enumValues(p.schema)!));

  const resultDecl: string[] = [];
  if (shape.kind === "object") {
    const name = resultTypeName(action);
    const out = action.outputSchema as { title?: string; description?: string };
    const block = propertyBlock(name, Object.entries(shape.properties), new Set(shape.required), undefined);
    const title = out.title ?? `${action.title} Result`;
    resultDecl.push(
      "",
      `/// ${commentText(out.description ?? `The result of ${action.title}.`)}`,
      `struct ${name}: TransientAppEntity {`,
      `    static let typeDisplayRepresentation: TypeDisplayRepresentation = ${swiftString(title)}`,
      "",
      ...block.decls,
      "    var displayRepresentation: DisplayRepresentation {",
      `        DisplayRepresentation(title: ${swiftString(title)})`,
      "    }",
      "",
      "    init() {}",
      "",
      ...initializer(block.models, block.models.map((m) => `self.${m.swiftName} = ${m.swiftName}`)),
      "}",
      ...block.enums.flatMap((e) => ["", e.trimEnd()]),
    );
  }

  return lines([
    `// ${HEADER}`,
    "",
    "import AppIntents",
    "import Foundation",
    "",
    `/// ${commentText(action.description)}`,
    `/// Safety: ${action.safety}.`,
    "@AppIntent(.tool)",
    `struct ${typeName}: AppIntent {`,
    `    static let title: LocalizedStringResource = ${swiftString(action.title)}`,
    "    static let description = IntentDescription(",
    `        LocalizedStringResource(${swiftString(action.description)})`,
    "    )",
    `    static let authenticationPolicy: IntentAuthenticationPolicy = ${AUTH_SWIFT[actionAuth(manifest, action)]}`,
    "",
    ...params.flatMap(parameterDecl),
    `    func perform() async throws -> ${resultClause} {`,
    ...body.map((l) => `        ${l}`),
    "    }",
    "}",
    ...enums.flatMap((e) => ["", e.trimEnd()]),
    ...resultDecl,
  ]);
}

// ---------------------------------------------------------------- skills + readme

function yamlScalar(s: string): string {
  return /^[\w(][^:#]*$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s);
}

function skillFile(skill: { name: string; description: string; instructions: string }): string {
  return lines(["---", `name: ${skill.name}`, `description: ${yamlScalar(skill.description)}`, "---", skill.instructions.trim()]);
}

function readme(manifest: Manifest, actions: Action[]): string {
  const rows = actions.map((a) => {
    const confirm = needsConfirmation(a) ? `yes (${SAFETY[a.safety].siriActionName(a.confirmation?.acceptLabel).split("(")[0]})` : "no";
    return `| \`${pascalCase(a.name)}Intent\` | ${a.safety} | \`${AUTH_SWIFT[actionAuth(manifest, a)]}\` | ${confirm} |`;
  });
  const skipped = manifest.actions.filter((a) => !isEnabledFor(a, "ios")).map((a) => a.name);
  return lines([
    `# ${manifest.app.name}: Siri tool intents (generated)`,
    "",
    HEADER,
    "",
    "These files turn the actions in `omnintent.json` into App Intents marked as Siri tools",
    "(`@AppIntent(.tool)`, Siri AI Developer Preview, iOS 27.3+, built with Xcode 27). Apple finds",
    "App Intents when it builds your app, so the intents are plain Swift that call your code through",
    "the `OmnintentHandlers` protocol.",
    "",
    "## Wire it up",
    "",
    "1. Add the `OmnintentGenerated` folder to your app target.",
    "2. Implement `OmnintentHandlers` (one method per action plus two lookups per entity) using your",
    "   existing models and services. Return the generated `...Entity` types.",
    "3. Register the handlers once at launch, before any intent can run:",
    "",
    "   ```swift",
    "   @main",
    `   struct ${pascalCase(manifest.app.slug)}App: App {`,
    "       init() {",
    "           OmnintentRuntime.register(MyOmnintentHandlers())",
    "       }",
    "       var body: some Scene { WindowGroup { ContentView() } }",
    "   }",
    "   ```",
    "",
    skillsFor(manifest, "ios").length
      ? "4. Add an app skills bundle: in Xcode choose File > New > File from Template > Skills Bundle, keep the name `Skills`, then copy the folders from `Skills.skillsbundle/Skills/` into it. An app target can contain only one `.skillsbundle`, and it must be in Copy Bundle Resources."
      : "4. This manifest has no skills, so there is no skills bundle to add.",
    "",
    "## Before you ship",
    "",
    "- Adding any tool intent makes your App Shortcuts unavailable to Siri (they stay available to",
    "  Spotlight and the Action button). Make sure these tool intents cover what your App Shortcuts did.",
    "- If an intent already conforms to an app schema in a Siri-supported domain, do not also mark it",
    "  as a tool; disable it here with `platforms.ios.enabled: false`.",
    "- Siri finds entities through Spotlight or an `EnumerableEntityQuery`. The generated queries call",
    "  your `all...Entities()` handlers; index large collections in Spotlight instead.",
    "- Siri AI Developer Preview features work only in development builds and internal TestFlight builds.",
    "",
    "## Safety mapping for this app",
    "",
    "| Intent | Safety | `authenticationPolicy` | Confirmation (`requestConfirmation`) |",
    "| --- | --- | --- | --- |",
    ...rows,
    skipped.length ? "" : false,
    skipped.length ? `Not generated for iOS (platforms.ios.enabled is false): ${skipped.map((s) => `\`${s}\``).join(", ")}.` : false,
    "",
    "## Test",
    "",
    "- Run the Siri Integration Advisor in Xcode.",
    "- Write App Intents tests with the AppIntentsTesting framework, and script the sample utterances",
    "  from `omnintent.json` with the SiriEvaluations framework (`omnintent test --plan <dir>` lists them).",
  ]);
}
