import { execFileSync } from "node:child_process";

/**
 * Helpers for type-checking generated Swift with a real Swift compiler and iOS SDK (macOS with
 * Xcode only). The generated code targets the iOS 27 SDK. When only an older SDK is installed,
 * `forOlderSdk` removes the few iOS 27 additions so everything else can still be checked.
 */

export interface IosSdk {
  /** For example "26.5". */
  version: string;
  major: number;
  /** Target triple for type-checking, for example "arm64-apple-ios26.5-simulator". */
  target: string;
}

/** The installed iOS Simulator SDK, or undefined when there is no Xcode. */
export function findIosSdk(): IosSdk | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const version = execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const major = Number.parseInt(version, 10);
    if (!Number.isFinite(major)) return undefined;
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    return { version, major, target: `${arch}-apple-ios${version}-simulator` };
  } catch {
    return undefined;
  }
}

/** First iOS SDK with Siri tool intents and the newer `@Property` arguments. */
export const IOS_TOOL_SDK_MAJOR = 27;

const PROPERTY_LINE = /^(\s*@Property\(title: "(?:[^"\\]|\\.)*")(?:, [^\n]*)?\)$/gm;

/**
 * Removes the iOS 27 additions that an older SDK rejects, and nothing else:
 * - `@AppIntent(.tool)` (the Siri tool macro),
 * - `@Property` arguments other than `title:` (`description:`, `visibility:`, `authenticationPolicy:`).
 *
 * `static let authenticationPolicy` on `AppEntity` types is kept: older SDKs compile it as a plain
 * static property that nothing reads.
 */
export function forOlderSdk(source: string): string {
  return source.replace(/^@AppIntent\(\.tool\)\n/gm, "").replace(PROPERTY_LINE, "$1)");
}

/** Arguments for `swiftc -typecheck` in Swift 6 language mode, optionally with MainActor default isolation. */
export function swiftcTypecheckArgs(sdk: IosSdk, files: string[], mainActorDefault: boolean): string[] {
  const isolation = mainActorDefault
    ? [
        "-default-isolation",
        "MainActor",
        "-enable-upcoming-feature",
        "NonisolatedNonsendingByDefault",
        "-enable-upcoming-feature",
        "InferIsolatedConformances",
      ]
    : [];
  return [
    "--sdk",
    "iphonesimulator",
    "swiftc",
    "-typecheck",
    "-target",
    sdk.target,
    "-swift-version",
    "6",
    "-strict-concurrency=complete",
    "-warnings-as-errors",
    ...isolation,
    "-parse-as-library",
    ...files,
  ];
}
