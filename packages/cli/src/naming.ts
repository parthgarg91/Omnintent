// Identifier helpers shared by the generators.

export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function camelCase(input: string): string {
  const parts = words(input).map((w) => w.toLowerCase());
  return parts.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
}

export function pascalCase(input: string): string {
  const c = camelCase(input);
  return c ? c[0].toUpperCase() + c.slice(1) : c;
}

export function snakeCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join("_");
}

export function kebabCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join("-");
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
const ACRONYMS = new Map([
  ["id", "ID"],
  ["url", "URL"],
  ["uri", "URI"],
  ["api", "API"],
]);

export function titleCase(input: string): string {
  return words(input)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return ACRONYMS.get(lower)!;
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function isSnakeCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name);
}

export function isCamelCase(name: string): boolean {
  return /^[a-z][A-Za-z0-9]*$/.test(name);
}

const SWIFT_KEYWORDS = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout",
  "internal", "let", "operator", "private", "precedencegroup", "protocol", "public", "rethrows",
  "static", "struct", "subscript", "typealias", "var", "break", "case", "catch", "continue", "default",
  "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "throw", "switch",
  "where", "while", "as", "Any", "false", "is", "nil", "self", "Self", "super", "throws", "true", "try",
]);

const KOTLIN_KEYWORDS = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is",
  "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof",
  "val", "var", "when", "while",
]);

export function swiftIdent(name: string): string {
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

export function kotlinIdent(name: string): string {
  return KOTLIN_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

/** Turns an enum raw value such as "in-progress" into a Swift case name. */
export function enumCaseName(raw: string): string {
  let c = camelCase(raw);
  if (!c) c = "value";
  if (/^[0-9]/.test(c)) c = `v${c}`;
  return swiftIdent(c);
}

function escapeChars(s: string, unicode: (code: number) => string, extra: Record<string, string> = {}): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (extra[ch]) out += extra[ch];
    else if (code < 0x20 || code === 0x7f) out += unicode(code);
    else out += ch;
  }
  return out;
}

/** Swift string literal. */
export function swiftString(s: string): string {
  return `"${escapeChars(s, (c) => `\\u{${c.toString(16)}}`)}"`;
}

/** Kotlin string literal; `$` is escaped so it is never a template. */
export function kotlinString(s: string): string {
  return `"${escapeChars(s, (c) => `\\u${c.toString(16).padStart(4, "0")}`, { $: "\\$" })}"`;
}

/** Text safe inside a /** KDoc *\/ or /// comment. */
export function commentText(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/\r?\n/g, " ").trim();
}

export function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "&#10;");
}

/** Strips a trailing Id/ID: listId -> list. Used for Siri entity parameters. */
export function stripIdSuffix(name: string): string {
  const stripped = name.replace(/(Id|ID|_id)$/, "");
  return stripped && stripped !== name ? stripped : `${name}Entity`;
}
