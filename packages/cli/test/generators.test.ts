import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, writeFiles } from "../src/generators/index.js";
import { generateKotlin } from "../src/generators/kotlin.js";
import { generateMcp } from "../src/generators/mcp.js";
import { generateSwift } from "../src/generators/swift.js";
import type { Manifest } from "../src/manifest.js";
import { GENERATED_DIR, REPO, loadExample, paymentManifest, variant } from "./helpers.js";

const IGNORED = new Set(["node_modules", ".wrangler", ".dev.vars"]);

function committedFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (IGNORED.has(name)) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const file = (files: { path: string; content: string }[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`missing ${path}; have ${files.map((x) => x.path).join(", ")}`);
  return f.content;
};

describe("golden files: examples/todo/generated", () => {
  const files = generate(loadExample(), ["swift", "kotlin", "mcp"]);

  if (process.env.UPDATE_GOLDEN === "1") {
    writeFiles(GENERATED_DIR, files);
  }

  it("generates exactly the committed set of files", () => {
    expect(files.map((f) => f.path).sort()).toEqual(committedFiles(GENERATED_DIR));
  });

  for (const target of ["swift", "kotlin", "mcp"]) {
    it(`matches the committed ${target} output byte for byte`, () => {
      const mismatched = files
        .filter((f) => f.path.startsWith(`${target}/`))
        .filter((f) => readFileSync(join(GENERATED_DIR, f.path), "utf8") !== f.content)
        .map((f) => f.path);
      expect(mismatched, "regenerate with: UPDATE_GOLDEN=1 npx vitest run generators").toEqual([]);
    });
  }

  it("is deterministic", () => {
    const again = generate(loadExample(), ["swift", "kotlin", "mcp"]);
    expect(again).toEqual(files);
  });
});

describe("swift generator", () => {
  const files = generateSwift(loadExample());

  it("marks each action as a Siri tool with title, description and parameter docs", () => {
    const add = file(files, "OmnintentGenerated/Intents/AddItemIntent.swift");
    expect(add).toContain("@AppIntent(.tool)\nstruct AddItemIntent: AppIntent {");
    expect(add).toContain('static let title: LocalizedStringResource = "Add Item"');
    expect(add).toContain('LocalizedStringResource("Adds a new item to a to-do list and returns the created item.")');
    expect(add).toContain('@Parameter(title: "List", description: LocalizedStringResource("The list to add the item to, for example \\"groceries\\"."))\n    var list: TodoListEntity');
    expect(add).toContain("var dueDate: Date?");
    expect(add).toContain("listId: list.id,");
  });

  it("maps safety levels to authentication and confirmation", () => {
    const list = file(files, "OmnintentGenerated/Intents/ListListsIntent.swift");
    expect(list).not.toContain("requestConfirmation");
    const del = file(files, "OmnintentGenerated/Intents/DeleteItemIntent.swift");
    expect(del).toContain("static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication");
    expect(del).toContain('actionName: .custom(acceptLabel: "Delete", acceptAlternatives: [], denyLabel: "Cancel", denyAlternatives: [], destructive: true)');
    expect(del).toContain('dialog: "Delete \\"\\(item.title)\\" permanently?"');

    const pay = generateSwift(paymentManifest());
    const order = file(pay, "OmnintentGenerated/Intents/PlaceOrderIntent.swift");
    expect(order).toContain("authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication");
    expect(order).toContain("actionName: .pay,");
    expect(order).toContain('default: .small');
  });

  it("lets write actions lower authentication, but never destructive ones", () => {
    const lowered = generateSwift(
      variant((m) => {
        m.actions[5].authentication = "none"; // share_list: write, returns no entity
        m.actions[4].authentication = "none"; // delete_item: destructive
      }),
    );
    expect(file(lowered, "OmnintentGenerated/Intents/ShareListIntent.swift")).toContain("IntentAuthenticationPolicy = .alwaysAllowed");
    expect(file(lowered, "OmnintentGenerated/Intents/DeleteItemIntent.swift")).toContain("IntentAuthenticationPolicy = .requiresAuthentication");
  });

  it("generates entities with queries, internal visibility and property policies", () => {
    const item = file(files, "OmnintentGenerated/Entities/TodoItemEntity.swift");
    expect(item).toContain("struct TodoItemEntity: AppEntity {");
    expect(item).toContain("static let defaultQuery = TodoItemEntityQuery()");
    expect(item).toContain('@Property(title: "Notes", description: "Private notes the app keeps for its own use.", visibility: .internal)');
    expect(item).toContain("struct TodoItemEntityQuery: EnumerableEntityQuery {");
    const order = file(generateSwift(paymentManifest()), "OmnintentGenerated/Entities/OrderEntity.swift");
    expect(order).toContain("authenticationPolicy: .requiresLocalDeviceAuthentication)\n    var cardLast4: String?");
  });

  it("writes app skills in Apple's SKILL.md layout", () => {
    const skill = file(files, "Skills.skillsbundle/Skills/tidy-list/SKILL.md");
    expect(skill.startsWith("---\nname: tidy-list\ndescription: Reviews one to-do list")).toBe(true);
  });

  it("produces Swift that parses without syntax errors (tree-sitter-swift)", async () => {
    const require = createRequire(import.meta.url);
    let Parser: new () => { setLanguage(l: unknown): void; parse(s: string): { rootNode: { hasError: boolean } } };
    let Swift: unknown;
    try {
      Parser = require("tree-sitter");
      Swift = require("tree-sitter-swift");
    } catch {
      console.warn("tree-sitter-swift is not installed; skipping the Swift syntax check");
      return;
    }
    const parser = new Parser();
    parser.setLanguage(Swift);
    const all = [...files, ...generateSwift(paymentManifest())].filter((f) => f.path.endsWith(".swift"));
    const broken = all.filter((f) => parser.parse(f.content).rootNode.hasError).map((f) => f.path);
    expect(broken).toEqual([]);
    expect(parser.parse("struct X { func ( }").rootNode.hasError).toBe(true);
  });
});

describe("kotlin generator", () => {
  const files = generateKotlin(loadExample());
  const dir = "src/main/kotlin/com/example/todoexample/omnintent";

  it("writes an AppFunctionService entry point with KDoc from the manifest", () => {
    const service = file(files, `${dir}/BaseTodoExampleAppFunctionService.kt`);
    expect(service).toContain('@AppFunctionServiceEntryPoint(\n    serviceName = "TodoExampleAppFunctionService",\n    appFunctionXmlFileName = "todo_example_app_function_service",\n)');
    expect(service).toContain("abstract class BaseTodoExampleAppFunctionService : AppFunctionService() {");
    expect(service).toContain("     * Adds a new item to a to-do list and returns the created item.\n     *\n     * @param listId");
    expect(service).toContain('Example: "milk".');
    expect(service).toContain("@AppFunctionDeclaration(isDescribedByKDoc = true)");
    expect(service).toContain('@AppFunctionStringValueConstraint(enumValues = ["open", "done", "all"]) status: String? = null');
    expect(service).toContain('handlers.listItems(listId = listId, status = status ?: "open")');
  });

  it("applies Android safety rules", () => {
    const service = file(files, `${dir}/BaseTodoExampleAppFunctionService.kt`);
    expect(service).not.toContain("fun deleteItem");
    expect(service).not.toContain("fun shareList"); // write action that requires confirmation
    expect(service).toContain("@AppFunctionDeclaration(isDescribedByKDoc = true)\n    suspend fun completeItem(");
    const optIn = generateKotlin(
      variant((m) => {
        m.actions[4].platforms = { android: { enabled: true } };
        m.actions[5].platforms = { android: { enabled: true } };
      }),
    );
    const optInService = file(optIn, `${dir}/BaseTodoExampleAppFunctionService.kt`);
    expect(optInService).toContain("@AppFunctionDeclaration(isEnabled = false, isDescribedByKDoc = true)\n    suspend fun deleteItem(");
    expect(optInService).toContain("@AppFunctionDeclaration(isEnabled = false, isDescribedByKDoc = true)\n    suspend fun shareList(");
    const pay = generateKotlin(paymentManifest());
    const payService = file(pay, "src/main/kotlin/com/example/coffee/omnintent/BaseCoffeeShopAppFunctionService.kt");
    expect(payService).not.toContain("placeOrder");
    const order = file(pay, "src/main/kotlin/com/example/coffee/omnintent/Order.kt");
    expect(order).not.toContain("cardLast4");
  });

  it("keeps internal properties out of serializable classes", () => {
    const item = file(files, `${dir}/TodoItem.kt`);
    expect(item).toContain("@AppFunctionSerializable(isDescribedByKDoc = true)\ndata class TodoItem(");
    expect(item).toContain("    val dueDate: LocalDate? = null,");
    expect(item).not.toContain("notes");
  });

  it("writes app metadata, manifest and Gradle snippets", () => {
    expect(file(files, "src/main/res/xml/app_metadata.xml")).toContain('appfn:instructions="A personal to-do app');
    expect(file(files, "AndroidManifest.snippet.xml")).toContain(
      'android:name="com.example.todoexample.omnintent.TodoExampleAppFunctionService"',
    );
    const gradle = file(files, "build.gradle.kts.snippet");
    expect(gradle).toContain('implementation("androidx.appfunctions:appfunctions:1.0.0")');
    expect(gradle).toContain('ksp("androidx.appfunctions:appfunctions-compiler:1.0.0")');
  });

  const kotlinc = [process.env.KOTLINC, resolve(REPO, ".tools/kotlinc/bin/kotlinc")].find((p) => p && existsSync(p));
  it.runIf(!!kotlinc)(
    "compiles against AppFunctions API stubs with kotlinc",
    () => {
      const out = mkdtempSync(join(tmpdir(), "omnintent-kt-"));
      const sources: string[] = [];
      for (const [name, manifest] of [
        ["todo", loadExample()],
        ["coffee", paymentManifest()],
        ["todo-optin", variant((m) => {
          m.app.android = { packageName: "com.example.optin" };
          m.actions[4].platforms = { android: { enabled: true } };
          m.actions[5].platforms = { android: { enabled: true } };
        })],
      ] as [string, Manifest][]) {
        const target = join(out, name);
        writeFiles(target, generateKotlin(manifest));
        sources.push(join(target, "src"));
      }
      const fixtures = resolve(REPO, "packages/cli/test/fixtures");
      execFileSync(
        kotlinc!,
        [join(fixtures, "kotlin-stubs"), join(fixtures, "kotlin-impl"), ...sources, "-d", join(out, "classes"), "-nowarn"],
        { stdio: "pipe" },
      );
      expect(existsSync(join(out, "classes/com/example/todoexample/omnintent/BaseTodoExampleAppFunctionService.class"))).toBe(true);
    },
    240_000,
  );
});

describe("mcp generator", () => {
  const files = generateMcp(loadExample());

  it("maps safety levels to MCP annotations and confirmation modes", () => {
    const tools = file(files, "src/tools.ts");
    const json = JSON.parse(tools.slice(tools.indexOf("export const TOOLS: ToolDefinition[] = ") + 39).replace(/;\s*$/, "")) as {
      name: string;
      annotations: Record<string, boolean>;
      confirmation?: { mode: string; prompt: string };
    }[];
    const byName = Object.fromEntries(json.map((t) => [t.name, t]));
    expect(byName.list_items.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(byName.add_item.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(byName.delete_item.annotations.destructiveHint).toBe(true);
    expect(byName.delete_item.confirmation).toEqual({ mode: "elicit-or-host", prompt: 'Delete "{itemId}" permanently?' });
    expect(byName.share_list.annotations.openWorldHint).toBe(true);
    expect(byName.list_items.confirmation).toBeUndefined();

    const pay = file(generateMcp(paymentManifest()), "src/tools.ts");
    expect(pay).toContain('"mode": "elicit-required"');
    expect(pay).toContain('"openWorldHint": true');
    expect(pay).not.toContain("cardLast4");
  });

  it("publishes plain JSON Schemas without Omnintent keywords", () => {
    const tools = file(files, "src/tools.ts");
    expect(tools).not.toContain("x-omnintent");
    expect(tools).not.toContain('"visibility"');
    expect(tools).not.toContain('"notes"');
  });

  it("refuses to generate without a backend", () => {
    expect(() => generateMcp(variant((m) => delete m.backend))).toThrow(/backend section/);
  });

  it("writes a Workers project", () => {
    const pkg = JSON.parse(file(files, "package.json"));
    expect(pkg.dependencies).toMatchObject({ "@modelcontextprotocol/server": "2.4.0", agents: "0.34.0" });
    expect(pkg.devDependencies.wrangler).toBeDefined();
    expect(file(files, "wrangler.jsonc")).toContain('"compatibility_flags": [\n    "nodejs_compat"\n  ]');
    expect(file(files, "src/index.ts")).toContain('import { createMcpHandler } from "agents/mcp/server";');
  });
});
