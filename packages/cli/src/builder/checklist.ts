// Turns the "Wire it up" and "Before you ship" sections of a generated README
// into a Markdown task list for the pull request.

const SECTIONS = ["Wire it up", "Before you ship", "Safety rules applied"];

/** Returns the body of each `## <title>` section in the README, keyed by title. */
function sections(readme: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = readme.split(/^## +/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    out.set(title, newline === -1 ? "" : part.slice(newline + 1));
  }
  return out;
}

/** Items of a Markdown list (numbered or bulleted), joined onto one line, with code blocks dropped. */
export function listItems(body: string): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  let inCode = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const start = /^(?:\d+\.|[-*])\s+(.*)$/.exec(line);
    if (start) {
      if (current) items.push(current.join(" "));
      current = [start[1].trim()];
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line.trim());
    } else if (current && line.trim() === "") {
      // A blank line may separate an item from its code block; keep the item open.
    } else if (current) {
      items.push(current.join(" "));
      current = undefined;
    }
  }
  if (current) items.push(current.join(" "));
  return items.map((i) => i.replace(/:\s*$/, ".").replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Checklist lines ("- [ ] ...") from a generated README. */
export function readmeChecklist(readme: string): string[] {
  const found = sections(readme);
  const lines: string[] = [];
  for (const title of SECTIONS) {
    const body = found.get(title);
    if (!body) continue;
    for (const item of listItems(body)) lines.push(`- [ ] ${item}`);
  }
  return lines;
}
