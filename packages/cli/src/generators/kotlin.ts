// Kotlin target: Android AppFunctions (androidx.appfunctions 1.0.0, Android 16+).
// Generates an abstract AppFunctionService entry point whose KDoc comes from
// the manifest, @AppFunctionSerializable data classes, and a handler interface.
// The AppFunctions KSP compiler turns the entry point into the real service.

import type { Action, Entity, EntityProperty, Manifest, ParameterSchema, ValueSchema } from "../manifest.js";
import { camelCase, commentText, kotlinIdent, kotlinString, pascalCase, snakeCase, xmlAttr } from "../naming.js";
import { androidRule, isEnabledFor, skillsFor } from "../safety.js";
import { agentVisibleProperties, outputShape } from "../schema.js";
import { HEADER, exampleValue, lines, lowerFirst, type GeneratedFile } from "./types.js";

export const APPFUNCTIONS_VERSION = "1.0.0";
export const KSP_VERSION = "2.3.13";
/** The generated service switches to Dispatchers.IO; androidx.appfunctions does not expose coroutines to apps. */
export const COROUTINES_VERSION = "1.11.0";

interface KotlinNames {
  packageName: string;
  servicePackage: string;
  baseClass: string;
  serviceName: string;
  xmlFileName: string;
}

export function kotlinNames(manifest: Manifest): KotlinNames {
  const packageName = manifest.app.android?.packageName ?? `com.example.${manifest.app.slug.replace(/-/g, "")}`;
  const appPascal = pascalCase(manifest.app.slug);
  return {
    packageName,
    servicePackage: `${packageName}.omnintent`,
    baseClass: `Base${appPascal}AppFunctionService`,
    serviceName: `${appPascal}AppFunctionService`,
    xmlFileName: `${snakeCase(manifest.app.slug)}_app_function_service`,
  };
}

export function generateKotlin(manifest: Manifest): GeneratedFile[] {
  const names = kotlinNames(manifest);
  const dir = `src/main/kotlin/${names.servicePackage.replace(/\./g, "/")}`;
  const actions = manifest.actions.filter((a) => isEnabledFor(a, "android"));
  const files: GeneratedFile[] = [];

  // The AppFunctions compiler rejects an entry point without functions
  // ("Class must have at least one AppFunction"), so generate nothing to build.
  if (!actions.length) return [{ path: "README.md", content: emptyReadme(manifest) }];

  for (const [name, entity] of Object.entries(manifest.entities ?? {})) {
    files.push({ path: `${dir}/${name}.kt`, content: dataClassFile(names, name, entity.description, agentVisibleProperties(entity), entity.required ?? []) });
  }
  for (const action of actions) {
    const shape = outputShape(action);
    if (shape.kind === "object") {
      const out = action.outputSchema as { description?: string };
      const props = agentVisibleProperties({ privacy: undefined, properties: shape.properties });
      files.push({
        path: `${dir}/${pascalCase(action.name)}Result.kt`,
        content: dataClassFile(names, `${pascalCase(action.name)}Result`, out.description ?? `The result of ${action.title}.`, props, shape.required),
      });
    }
  }
  files.push({ path: `${dir}/OmnintentHandlers.kt`, content: handlersFile(manifest, names, actions) });
  files.push({ path: `${dir}/${names.baseClass}.kt`, content: serviceFile(manifest, names, actions) });
  files.push({ path: "src/main/res/xml/app_metadata.xml", content: appMetadata(manifest) });
  files.push({ path: "AndroidManifest.snippet.xml", content: manifestSnippet(names) });
  files.push({ path: "build.gradle.kts.snippet", content: gradleSnippet() });
  files.push({ path: "README.md", content: readme(manifest, names, actions) });
  return files;
}

// ---------------------------------------------------------------- types

const TYPE_IMPORTS: Record<string, string> = {
  LocalDate: "java.time.LocalDate",
  Instant: "java.time.Instant",
  Uri: "android.net.Uri",
};

function scalarType(type: string, format: string | undefined): string {
  if (type === "string") {
    if (format === "date") return "LocalDate";
    if (format === "date-time") return "Instant";
    if (format === "uri") return "Uri";
    return "String";
  }
  if (type === "integer") return format === "int64" ? "Long" : "Int";
  if (type === "number") return "Double";
  return "Boolean";
}

const PRIMITIVE_ARRAYS: Record<string, string> = {
  Int: "IntArray",
  Long: "LongArray",
  Double: "DoubleArray",
  Boolean: "BooleanArray",
};

function valueType(schema: ValueSchema): string {
  if (schema.type === "array") {
    const item = scalarType(schema.items!.type, schema.items!.format);
    return PRIMITIVE_ARRAYS[item] ?? `List<${item}>`;
  }
  return scalarType(schema.type, schema.format);
}

function emptyValue(type: string): string {
  if (type.startsWith("List<")) return "emptyList()";
  const arrays: Record<string, string> = { IntArray: "intArrayOf()", LongArray: "longArrayOf()", DoubleArray: "doubleArrayOf()", BooleanArray: "booleanArrayOf()" };
  return arrays[type] ?? "null";
}

function isCollection(type: string): boolean {
  return type.startsWith("List<") || type.endsWith("Array");
}

function kotlinLiteral(value: unknown, type: string): string | undefined {
  if (typeof value === "string") return type === "String" ? kotlinString(value) : undefined;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (type === "Double") return Number.isInteger(value) ? `${value}.0` : String(value);
    if (type === "Long") return `${value}L`;
    return String(value);
  }
  return undefined;
}

function collectImports(types: string[]): string[] {
  const found = new Set<string>();
  for (const t of types) for (const [name, imp] of Object.entries(TYPE_IMPORTS)) if (new RegExp(`\\b${name}\\b`).test(t)) found.add(imp);
  return [...found].sort();
}

// ---------------------------------------------------------------- data classes

function dataClassFile(
  names: KotlinNames,
  className: string,
  description: string,
  props: [string, EntityProperty][],
  required: string[],
): string {
  const req = new Set(required);
  const fields = props.flatMap(([name, prop]) => {
    const type = valueType(prop);
    const optional = !req.has(name);
    const allowed = prop.enum ? ` One of: ${prop.enum.join(", ")}.` : "";
    const decl = optional
      ? isCollection(type)
        ? `    val ${kotlinIdent(name)}: ${type} = ${emptyValue(type)},`
        : `    val ${kotlinIdent(name)}: ${type}? = null,`
      : `    val ${kotlinIdent(name)}: ${type},`;
    return [`    /** ${commentText(prop.description + allowed)} */`, decl];
  });
  const imports = collectImports(props.map(([, p]) => valueType(p)));
  return lines([
    `// ${HEADER}`,
    `package ${names.servicePackage}`,
    "",
    "import androidx.appfunctions.AppFunctionSerializable",
    ...imports.map((i) => `import ${i}`),
    "",
    `/** ${commentText(description)} */`,
    "@AppFunctionSerializable(isDescribedByKDoc = true)",
    `data class ${className}(`,
    ...fields,
    ")",
  ]);
}

// ---------------------------------------------------------------- functions

interface KParam {
  name: string;
  ident: string;
  schema: ParameterSchema;
  required: boolean;
  /** Type in the AppFunction signature. */
  type: string;
  /** Default in the AppFunction signature ("" when required). */
  signatureDefault: string;
  /** Type the handler receives after defaults are resolved. */
  handlerType: string;
  /** Expression passed to the handler. */
  handlerArg: string;
}

function kParams(action: Action): KParam[] {
  const required = new Set(action.inputSchema.required ?? []);
  return Object.entries(action.inputSchema.properties ?? {}).map(([name, schema]) => {
    const base = valueType(schema);
    const ident = kotlinIdent(name);
    if (required.has(name)) {
      return { name, ident, schema, required: true, type: base, signatureDefault: "", handlerType: base, handlerArg: ident };
    }
    if (isCollection(base)) {
      return { name, ident, schema, required: false, type: base, signatureDefault: emptyValue(base), handlerType: base, handlerArg: ident };
    }
    const literal = schema.default !== undefined ? kotlinLiteral(schema.default, base) : undefined;
    return {
      name,
      ident,
      schema,
      required: false,
      type: `${base}?`,
      signatureDefault: "null",
      handlerType: literal ? base : `${base}?`,
      handlerArg: literal ? `${ident} ?: ${literal}` : ident,
    };
  });
}

function returnType(action: Action): string {
  const shape = outputShape(action);
  switch (shape.kind) {
    case "none":
      return "Unit";
    case "entity":
      return shape.entity;
    case "entityList":
      return `List<${shape.entity}>`;
    case "object":
      return `${pascalCase(action.name)}Result`;
  }
}

function handlersFile(manifest: Manifest, names: KotlinNames, actions: Action[]): string {
  const methods = actions.flatMap((a) => {
    const params = kParams(a).map((p) => `${p.ident}: ${p.handlerType}`);
    const ret = returnType(a);
    return [`    /** ${commentText(a.description)} */`, `    suspend fun ${camelCase(a.name)}(${params.join(", ")})${ret === "Unit" ? "" : `: ${ret}`}`, ""];
  });
  const imports = collectImports(actions.flatMap((a) => kParams(a).map((p) => p.handlerType)));
  return lines([
    `// ${HEADER}`,
    `package ${names.servicePackage}`,
    "",
    ...imports.map((i) => `import ${i}`),
    imports.length ? "" : false,
    "/**",
    ` * The app code that performs each action for ${commentText(manifest.app.name)}. Implement it with your`,
    " * existing repositories, then expose it from your Application class through",
    " * [OmnintentHandlersProvider]. Throw AppFunctionInvalidArgumentException or",
    " * AppFunctionElementNotFoundException with a plain-language message when a request cannot succeed.",
    " */",
    "interface OmnintentHandlers {",
    ...methods.slice(0, -1),
    "}",
    "",
    "/** Implement on your Application class so the generated AppFunctionService can find the handlers. */",
    "interface OmnintentHandlersProvider {",
    "    val omnintentHandlers: OmnintentHandlers",
    "}",
  ]);
}

/**
 * A manifest value as AppFunctions expects it in JSON. LocalDate, Instant and Uri are
 * objects there, not strings (an emulator rejects "2027-04-15" for a LocalDate).
 */
export function appFunctionsValue(value: unknown, schema: { type: string; format?: string; items?: { type: string; format?: string } }): unknown {
  if (Array.isArray(value)) return schema.items ? value.map((v) => appFunctionsValue(v, schema.items!)) : value;
  if (typeof value !== "string") return value;
  if (schema.format === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? { year: Number(m[1]), month: Number(m[2]), dayOfMonth: Number(m[3]) } : value;
  }
  if (schema.format === "date-time") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : { epochSecond: Math.floor(ms / 1000), nanoAdjustment: (((ms % 1000) + 1000) % 1000) * 1_000_000 };
  }
  if (schema.format === "uri") return { uri: value };
  return value;
}

function appFunctionsArgs(action: Action, args: Record<string, unknown>): Record<string, unknown> {
  const props = action.inputSchema.properties ?? {};
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, props[k] ? appFunctionsValue(v, props[k]) : v]));
}

function formatExample(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function returnDoc(manifest: Manifest, action: Action): string | undefined {
  const shape = outputShape(action);
  const describe = (e: Entity) => lowerFirst(e.description.replace(/\.$/, ""));
  switch (shape.kind) {
    case "none":
      return undefined;
    case "entity": {
      const e = manifest.entities![shape.entity];
      return `The ${e.title.toLowerCase()}: ${describe(e)}.`;
    }
    case "entityList": {
      const e = manifest.entities![shape.entity];
      return `The matching ${e.title.toLowerCase()} entries. Each is ${describe(e)}.`;
    }
    case "object": {
      const out = action.outputSchema as { description?: string };
      return out.description ?? `The result of ${action.title}.`;
    }
  }
}

function functionBlock(manifest: Manifest, action: Action): string[] {
  const params = kParams(action);
  const docs = params.map((p) => {
    const raw = exampleValue(p.name, p.schema, action.examples);
    const example = formatExample(raw === undefined ? undefined : appFunctionsValue(raw, p.schema));
    const d = p.schema.description.toLowerCase();
    const listsValues = p.schema.enum?.every((v) => d.includes(v.toLowerCase()));
    const values = p.schema.enum && !listsValues ? ` One of: ${p.schema.enum.join(", ")}.` : "";
    const def = !p.required && p.schema.default !== undefined && !d.includes("default") ? ` Defaults to ${JSON.stringify(p.schema.default)}.` : "";
    const ex = example ? ` Example: ${example}.` : "";
    return `     * @param ${p.name} ${commentText(p.schema.description + values + def + ex)}`;
  });
  const ret = returnDoc(manifest, action);
  const enabled = androidRule(action) === "opt-in" ? "isEnabled = false, " : "";

  const sig = params.map((p) => {
    const constraint = p.schema.enum ? `@AppFunctionStringValueConstraint(enumValues = [${p.schema.enum.map(kotlinString).join(", ")}]) ` : "";
    return `        ${constraint}${p.ident}: ${p.type}${p.signatureDefault ? ` = ${p.signatureDefault}` : ""},`;
  });

  const checks: string[] = [];
  for (const p of params) {
    if (p.type === "String" && p.required) {
      checks.push(`if (${p.ident}.isBlank()) throw AppFunctionInvalidArgumentException(${kotlinString(`${p.name} must not be blank.`)})`);
    }
    if (p.schema.enum) {
      const allowed = `setOf(${p.schema.enum.map(kotlinString).join(", ")})`;
      const value = p.required ? p.ident : `${p.ident} != null && ${p.ident}`;
      checks.push(
        `if (${value} !in ${allowed}) throw AppFunctionInvalidArgumentException(${kotlinString(`${p.name} must be one of: ${p.schema.enum.join(", ")}.`)})`,
      );
    }
  }
  const call = `handlers.${camelCase(action.name)}(${params.map((p) => `${p.ident} = ${p.handlerArg}`).join(", ")})`;
  const rt = returnType(action);
  return [
    "    /**",
    `     * ${commentText(action.description)}`,
    params.length || ret ? "     *" : false,
    ...docs,
    ret ? `     * @return ${commentText(ret)}` : false,
    "     */",
    `    @AppFunctionDeclaration(${enabled}isDescribedByKDoc = true)`,
    params.length ? `    suspend fun ${camelCase(action.name)}(` : `    suspend fun ${camelCase(action.name)}(): ${rt} = withContext(Dispatchers.IO) {`,
    ...(params.length ? [...sig, `    ): ${rt} = withContext(Dispatchers.IO) {`] : []),
    ...checks.map((c) => `        ${c}`),
    `        ${call}`,
    "    }",
  ].filter((l): l is string => l !== false);
}

function serviceFile(manifest: Manifest, names: KotlinNames, actions: Action[]): string {
  const blocks = actions.map((a) => functionBlock(manifest, a));
  const needsInvalidArg = blocks.some((b) => b.some((l) => l.includes("AppFunctionInvalidArgumentException")));
  const needsConstraint = blocks.some((b) => b.some((l) => l.includes("@AppFunctionStringValueConstraint")));
  const imports = collectImports(actions.flatMap((a) => kParams(a).map((p) => p.type)));
  const excluded = manifest.actions.filter((a) => !isEnabledFor(a, "android"));
  return lines([
    `// ${HEADER}`,
    `package ${names.servicePackage}`,
    "",
    "import androidx.annotation.RequiresApi",
    "import androidx.appfunctions.AppFunctionDeclaration",
    needsInvalidArg && "import androidx.appfunctions.AppFunctionInvalidArgumentException",
    "import androidx.appfunctions.AppFunctionService",
    "import androidx.appfunctions.AppFunctionServiceEntryPoint",
    needsConstraint && "import androidx.appfunctions.AppFunctionStringValueConstraint",
    ...imports.map((i) => `import ${i}`),
    "import kotlinx.coroutines.Dispatchers",
    "import kotlinx.coroutines.withContext",
    "",
    "/**",
    ` * AppFunctions for ${commentText(manifest.app.name)}. The AppFunctions compiler (KSP) generates the`,
    ` * concrete ${names.serviceName} from this class. Handlers come from the Application,`,
    " * which must implement [OmnintentHandlersProvider]. No dependency-injection framework is required.",
    excluded.length ? " *" : false,
    excluded.length
      ? ` * Not exposed on Android (they need confirmation or move money, or are disabled in the manifest): ${excluded.map((a) => a.name).join(", ")}.`
      : false,
    " */",
    "@RequiresApi(36)",
    "@AppFunctionServiceEntryPoint(",
    `    serviceName = ${kotlinString(names.serviceName)},`,
    `    appFunctionXmlFileName = ${kotlinString(names.xmlFileName)},`,
    ")",
    `abstract class ${names.baseClass} : AppFunctionService() {`,
    "    private val handlers: OmnintentHandlers",
    "        get() = (applicationContext as OmnintentHandlersProvider).omnintentHandlers",
    ...blocks.flatMap((b) => ["", ...b]),
    "}",
  ]);
}

// ---------------------------------------------------------------- resources

export function androidInstructions(manifest: Manifest): string {
  const parts = [manifest.app.description.trim()];
  if (manifest.app.instructions) parts.push(manifest.app.instructions.trim());
  const skills = skillsFor(manifest, "android");
  if (skills.length) {
    parts.push(["Workflows:", ...skills.map((s) => `- ${s.description.trim()} ${s.instructions.trim().replace(/\s*\n\s*/g, " ")}`)].join("\n"));
  }
  return parts.join("\n");
}

function appMetadata(manifest: Manifest): string {
  return lines([
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${HEADER} -->`,
    '<AppFunctionAppMetadata xmlns:appfn="http://schemas.android.com/apk/androidx.appfunctions"',
    `    appfn:instructions="${xmlAttr(androidInstructions(manifest))}" />`,
  ]);
}

function manifestSnippet(names: KotlinNames): string {
  return lines([
    `<!-- ${HEADER} -->`,
    "<!-- Paste inside <application> in src/main/AndroidManifest.xml. The <manifest> element needs",
    '     xmlns:tools="http://schemas.android.com/tools". -->',
    "<service",
    `    android:name="${names.servicePackage}.${names.serviceName}"`,
    '    android:permission="android.permission.BIND_APP_FUNCTION_SERVICE"',
    '    android:exported="true"',
    '    tools:targetApi="36">',
    "    <property",
    '        android:name="android.app.appfunctions.schema"',
    '        android:value="app_functions_schema.xsd" />',
    "    <property",
    '        android:name="android.app.appfunctions.v2"',
    `        android:value="${names.xmlFileName}.xml" />`,
    "    <intent-filter>",
    '        <action android:name="android.app.appfunctions.AppFunctionService" />',
    "    </intent-filter>",
    "</service>",
    "<property",
    '    android:name="android.app.appfunctions.app_metadata"',
    '    android:resource="@xml/app_metadata" />',
  ]);
}

function gradleSnippet(): string {
  return lines([
    `// ${HEADER}`,
    "// Merge into your app module's build.gradle.kts. AppFunctions needs compileSdk 37+ and",
    "// Android Gradle Plugin 9.1.0+. Use the KSP release that matches your Kotlin version;",
    `// ${KSP_VERSION} is the one Google's AppFunctions sample pairs with Kotlin 2.4.21.`,
    "plugins {",
    `    id("com.google.devtools.ksp") version "${KSP_VERSION}"`,
    "}",
    "",
    "android {",
    "    compileSdk = 37",
    "}",
    "",
    "dependencies {",
    `    implementation("androidx.appfunctions:appfunctions:${APPFUNCTIONS_VERSION}")`,
    `    ksp("androidx.appfunctions:appfunctions-compiler:${APPFUNCTIONS_VERSION}")`,
    "    // The generated service uses kotlinx.coroutines. Keep your own version if the app already has it.",
    `    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:${COROUTINES_VERSION}")`,
    "}",
  ]);
}

function readme(manifest: Manifest, names: KotlinNames, actions: Action[]): string {
  const excluded = manifest.actions.filter((a) => !isEnabledFor(a, "android"));
  const pkgPath = names.servicePackage;
  const firstAction = actions[0];
  return lines([
    `# ${manifest.app.name}: Android AppFunctions (generated)`,
    "",
    HEADER,
    "",
    `Targets \`androidx.appfunctions:appfunctions:${APPFUNCTIONS_VERSION}\` (stable since November 18, 2026) on`,
    "Android 16 (API 36) and later. Gemini reaches these functions through Google's Connected Apps Platform",
    "developer preview.",
    "",
    "## Wire it up",
    "",
    "1. Copy `src/` into your app module and merge `build.gradle.kts.snippet` into its build file.",
    "2. Paste `AndroidManifest.snippet.xml` inside `<application>`.",
    "3. Implement `OmnintentHandlers` with your repositories, and expose it from your Application:",
    "",
    "   ```kotlin",
    `   class MyApp : Application(), ${pkgPath}.OmnintentHandlersProvider {`,
    `       override val omnintentHandlers: ${pkgPath}.OmnintentHandlers by lazy { MyOmnintentHandlers(this) }`,
    "   }",
    "   ```",
    "",
    "   No dependency-injection framework is required. If you use Hilt, you can instead add",
    "   `@AndroidEntryPoint` to the generated base class and inject your handlers.",
    "4. Build. KSP generates the concrete service and the function schema XML.",
    "",
    "## Safety rules applied",
    "",
    "- AppFunctions should perform only safe tasks the user could do in your app, and they give the app no",
    "  confirmation step. So destructive actions, and write actions that require confirmation, are generated",
    "  only when the manifest opts in (`platforms.android.enabled: true`), and then with `isEnabled = false`.",
    "  Enable them at runtime with `AppFunctionManager.setAppFunctionEnabled` only after your own consent UI.",
    "  Payment actions are never generated for Android.",
    "- Properties marked `internal` or `sensitive` are left out of the returned data classes.",
    "- Agents omit optional parameters as null, zero, false or empty; the generated functions resolve manifest",
    "  defaults in the function body.",
    excluded.length ? `- Not generated here: ${excluded.map((a) => `\`${a.name}\` (${a.safety})`).join(", ")}.` : false,
    "",
    "## Verify on a device",
    "",
    "```sh",
    `adb shell cmd app_function list-app-functions --package ${manifest.app.android?.packageName ?? names.packageName}`,
    "```",
    firstAction ? "" : false,
    firstAction ? "Run one function directly (see `omnintent test --plan` for every sample):" : false,
    firstAction ? "" : false,
    firstAction ? "```sh" : false,
    firstAction ? adbExecute(manifest, names, firstAction) : false,
    firstAction ? "```" : false,
  ]);
}

function emptyReadme(manifest: Manifest): string {
  return lines([
    `# ${manifest.app.name}: Android AppFunctions (generated)`,
    "",
    HEADER,
    "",
    "Nothing was generated for Android: no action in the manifest can be exposed as an AppFunction.",
    "",
    ...manifest.actions.map((a) => `- \`${a.name}\` (${a.safety}): ${androidReason(a)}`),
    "",
    "AppFunctions give the app no confirmation step, so payment actions are never generated, and",
    "destructive actions or writes that need confirmation are generated only when the manifest sets",
    "`platforms.android.enabled: true`. The AppFunctions compiler also rejects a service with no",
    "functions, so no service, data classes or manifest snippet are written.",
  ]);
}

function androidReason(action: Action): string {
  const rule = androidRule(action);
  if (rule === "never") return "moves money, so it is never exposed on Android.";
  if (rule === "opt-in") return "needs confirmation; set `platforms.android.enabled: true` to expose it, disabled until your app enables it.";
  return "disabled in the manifest (`platforms.android.enabled: false`).";
}

export function adbExecute(manifest: Manifest, names: KotlinNames, action: Action, args?: Record<string, unknown>): string {
  const pkg = manifest.app.android?.packageName ?? names.packageName;
  const fn = `${names.servicePackage}.${names.baseClass}#${camelCase(action.name)}`;
  const params = JSON.stringify(appFunctionsArgs(action, args ?? action.examples[0]?.arguments ?? {}));
  return `adb shell "cmd app_function execute-app-function --package ${pkg} --function '${fn}' --parameters '${params.replace(/"/g, '\\"')}'"`;
}
