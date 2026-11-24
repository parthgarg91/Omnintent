#!/usr/bin/env node
// Builds a throwaway iOS app target that contains the generated Swift for a manifest, using
// xcodebuild, so Xcode's own App Intents metadata extraction runs on it. macOS with Xcode only.
//
//   npm run build
//   node scripts/xcode-build-check.mjs <omnintent.json> [handlers.swift ...]
//
// With an SDK older than iOS 27, the iOS 27 additions are removed first (see
// packages/cli/test/swift-sdk.ts) and the script says so. The app is built for the simulator
// without code signing; nothing is installed or run.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "packages/cli/dist/index.js");
if (!existsSync(dist)) fail("Run `npm run build` first.");
const { generateSwift, validateManifest } = await import(dist);
const { IOS_TOOL_SDK_MAJOR, findIosSdk, forOlderSdk } = await import(join(repo, "packages/cli/test/swift-sdk.ts"));

const [manifestPath, ...handlerFiles] = process.argv.slice(2);
if (!manifestPath) fail("Usage: node scripts/xcode-build-check.mjs <omnintent.json> [handlers.swift ...]");

const sdk = findIosSdk();
if (!sdk) fail("No iOS Simulator SDK found. This check needs macOS with Xcode.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const validation = validateManifest(manifest);
if (!validation.ok) fail(`${manifestPath} is not a valid manifest.`);

const older = sdk.major < IOS_TOOL_SDK_MAJOR;
const xcodeVersion = execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).split("\n")[0];
console.log(`${xcodeVersion}, iOS Simulator SDK ${sdk.version}`);
if (older) {
  console.log(
    `Note: the iOS ${sdk.version} SDK predates Siri tool intents. Building without @AppIntent(.tool) ` +
      "and @Property descriptions, visibility and policies.",
  );
}

const root = mkdtempSync(join(tmpdir(), "omnintent-xcode-"));
const src = join(root, "OmnintentHost");
const files = generateSwift(manifest).filter((f) => f.path.endsWith(".swift"));
for (const f of files) {
  const path = join(src, f.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, older ? forOlderSdk(f.content) : f.content);
}
for (const h of handlerFiles) copyFileSync(h, join(src, basename(h)));
writeFileSync(
  join(src, "HostApp.swift"),
  "import SwiftUI\n\n@main\nstruct HostApp: App {\n    var body: some Scene { WindowGroup { Text(\"Omnintent host\") } }\n}\n",
);
mkdirSync(join(root, "OmnintentHost.xcodeproj"));
writeFileSync(join(root, "OmnintentHost.xcodeproj/project.pbxproj"), pbxproj(sdk.version));

console.log(`Building ${files.length} generated Swift files in ${root}`);
try {
  execFileSync(
    "xcodebuild",
    [
      "-project", join(root, "OmnintentHost.xcodeproj"),
      "-target", "OmnintentHost",
      "-sdk", "iphonesimulator",
      `SYMROOT=${join(root, "build")}`,
      `OBJROOT=${join(root, "build/obj")}`,
      "build",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  const errors = out.split("\n").filter((l) => /\berror\b/.test(l) && !l.startsWith(" "));
  console.error(errors.join("\n") || out.slice(-4000));
  fail("xcodebuild failed.");
}

const app = join(root, "build/Debug-iphonesimulator/OmnintentHost.app");
const metadata = JSON.parse(readFileSync(join(app, "Metadata.appintents/extract.actionsdata"), "utf8"));
const actions = Object.keys(metadata.actions ?? {}).sort();
const entities = Object.keys(metadata.entities ?? {}).sort();
const expected = files.map((f) => f.path.match(/Intents\/(\w+Intent)\.swift$/)?.[1]).filter(Boolean).sort();
const missing = expected.filter((n) => !actions.includes(n));
console.log(`App Intents metadata: ${actions.length} intents (${actions.join(", ")}); ${entities.length} entities (${entities.join(", ")})`);
if (missing.length) fail(`Intents missing from Xcode's metadata: ${missing.join(", ")}`);
console.log("BUILD SUCCEEDED");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pbxproj(deploymentTarget) {
  const id = (n) => `0E0000000000000000000${String(n).padStart(3, "0")}`;
  const settings = {
    CODE_SIGNING_ALLOWED: "NO",
    GENERATE_INFOPLIST_FILE: "YES",
    INFOPLIST_KEY_UILaunchScreen_Generation: "YES",
    IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
    PRODUCT_BUNDLE_IDENTIFIER: "dev.omnintent.host",
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SDKROOT: "iphoneos",
    SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"',
    SWIFT_VERSION: "6.0",
    SWIFT_DEFAULT_ACTOR_ISOLATION: "MainActor",
    SWIFT_APPROACHABLE_CONCURRENCY: "YES",
    SWIFT_STRICT_CONCURRENCY: "complete",
    SWIFT_TREAT_WARNINGS_AS_ERRORS: "YES",
    TARGETED_DEVICE_FAMILY: "1",
  };
  const body = Object.entries(settings).map(([k, v]) => `${k} = ${v};`).join(" ");
  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {};
	objectVersion = 77;
	objects = {
		${id(1)} = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = OmnintentHost.app; sourceTree = BUILT_PRODUCTS_DIR; };
		${id(2)} = {isa = PBXFileSystemSynchronizedRootGroup; path = OmnintentHost; sourceTree = "<group>"; };
		${id(3)} = {isa = PBXGroup; children = (${id(2)}, ${id(4)}); sourceTree = "<group>"; };
		${id(4)} = {isa = PBXGroup; children = (${id(1)}); name = Products; sourceTree = "<group>"; };
		${id(5)} = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		${id(6)} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		${id(7)} = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		${id(8)} = {isa = PBXNativeTarget; buildConfigurationList = ${id(12)}; buildPhases = (${id(5)}, ${id(6)}, ${id(7)}); buildRules = (); dependencies = (); fileSystemSynchronizedGroups = (${id(2)}); name = OmnintentHost; productName = OmnintentHost; productReference = ${id(1)}; productType = "com.apple.product-type.application"; };
		${id(9)} = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; }; buildConfigurationList = ${id(13)}; compatibilityVersion = "Xcode 15.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = ${id(3)}; productRefGroup = ${id(4)}; projectDirPath = ""; projectRoot = ""; targets = (${id(8)}); };
		${id(10)} = {isa = XCBuildConfiguration; buildSettings = { ${body} }; name = Debug; };
		${id(11)} = {isa = XCBuildConfiguration; buildSettings = { SDKROOT = iphoneos; ALWAYS_SEARCH_USER_PATHS = NO; }; name = Debug; };
		${id(12)} = {isa = XCConfigurationList; buildConfigurations = (${id(10)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
		${id(13)} = {isa = XCConfigurationList; buildConfigurations = (${id(11)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
	};
	rootObject = ${id(9)};
}
`;
}
