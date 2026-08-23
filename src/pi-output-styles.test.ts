import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverStyles,
  loadStyleFile,
  resolveSavedStyle,
} from "./pi-output-styles-core.ts";

const parseFrontmatter = (content: string) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("missing frontmatter");
  return { frontmatter: JSON.parse(match[1]), body: match[2].trim() };
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-output-styles-"));
}

function markdown(metadata: Record<string, unknown>, body = "Instructions") {
  return `---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
}

void test("loadStyleFile reads valid metadata and uses the filename stem as id", async () => {
  const dir = await tempDir();
  const path = join(dir, "learning.md");
  await writeFile(
    path,
    markdown(
      {
        name: "Learning",
        description: "Learn",
        "keep-coding-instructions": true,
      },
      "Teach clearly.",
    ),
  );

  assert.deepEqual(await loadStyleFile(path, parseFrontmatter), {
    id: "learning",
    name: "Learning",
    description: "Learn",
    body: "Teach clearly.",
    path,
  });
});

void test("loadStyleFile rejects invalid frontmatter and metadata types", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "missing.md"), markdown({}));
  await assert.rejects(
    loadStyleFile(join(dir, "missing.md"), parseFrontmatter),
    /keep-coding-instructions must be true/,
  );
  await writeFile(
    join(dir, "false.md"),
    markdown({ "keep-coding-instructions": false }),
  );
  await assert.rejects(
    loadStyleFile(join(dir, "false.md"), parseFrontmatter),
    /keep-coding-instructions must be true/,
  );
  await writeFile(
    join(dir, "wrong-type.md"),
    markdown({ "keep-coding-instructions": "true" }),
  );
  await assert.rejects(
    loadStyleFile(join(dir, "wrong-type.md"), parseFrontmatter),
    /keep-coding-instructions must be true/,
  );
  await writeFile(
    join(dir, "name-number.md"),
    markdown({ name: 1, "keep-coding-instructions": true }),
  );
  await assert.rejects(
    loadStyleFile(join(dir, "name-number.md"), parseFrontmatter),
    /name must be a string/,
  );
  await writeFile(
    join(dir, "description-number.md"),
    markdown({ description: 1, "keep-coding-instructions": true }),
  );
  await assert.rejects(
    loadStyleFile(join(dir, "description-number.md"), parseFrontmatter),
    /description must be a string/,
  );
  const nonObjectPath = join(dir, "non-object.md");
  await writeFile(nonObjectPath, "---\n[]\n---\nInstructions\n");
  await assert.rejects(
    loadStyleFile(nonObjectPath, parseFrontmatter),
    /frontmatter must be an object/,
  );
});

void test("discoverStyles rescans new files and excludes duplicate display names", async () => {
  const dir = await tempDir();
  const stylesDir = join(dir, "styles");
  await mkdir(stylesDir);
  await writeFile(
    join(stylesDir, "first.md"),
    markdown({ name: "Same", "keep-coding-instructions": true }),
  );
  await writeFile(join(stylesDir, "ignored.txt"), "not a style");

  const first = await discoverStyles(stylesDir, parseFrontmatter);
  assert.deepEqual(
    first.styles.map((style) => style.id),
    ["first"],
  );
  assert.deepEqual(first.warnings, []);

  await writeFile(
    join(stylesDir, "second.md"),
    markdown({ name: "Same", "keep-coding-instructions": true }),
  );
  const second = await discoverStyles(stylesDir, parseFrontmatter);
  assert.deepEqual(second.styles, []);
  assert.ok(
    second.warnings.some(
      (warning) =>
        warning.includes("first.md") && warning.includes("second.md"),
    ),
  );

  await writeFile(
    join(stylesDir, "new.md"),
    markdown({ name: "New", "keep-coding-instructions": true }),
  );
  const third = await discoverStyles(stylesDir, parseFrontmatter);
  assert.deepEqual(
    third.styles.map((style) => style.id),
    ["new"],
  );
});

void test("discoverStyles treats a missing directory as an empty discovery", async () => {
  const result = await discoverStyles(
    join(await tempDir(), "missing"),
    parseFrontmatter,
  );
  assert.deepEqual(result, { styles: [], warnings: [] });
});

void test("discoverStyles excludes the reserved Default display name", async () => {
  const dir = await tempDir();
  const stylePath = join(dir, "default.md");
  await writeFile(
    stylePath,
    markdown({ name: "Default", "keep-coding-instructions": true }),
  );

  const result = await discoverStyles(dir, parseFrontmatter);
  assert.deepEqual(result.styles, []);
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.includes(stylePath) &&
        warning.includes('reserved display name "Default"'),
    ),
  );
});

void test("resolveSavedStyle falls back to Default for missing, corrupt, and removed state", async () => {
  const dir = await tempDir();
  const statePath = join(dir, "pi-output-style.local.json");
  const styles = [
    {
      id: "learning",
      name: "Learning",
      body: "Teach",
      path: join(dir, "learning.md"),
    },
  ];

  const missing = await resolveSavedStyle(statePath, styles);
  assert.equal(missing.activeStyle, undefined);
  assert.deepEqual(missing.warnings, []);

  await writeFile(statePath, JSON.stringify({ style: "learning" }));
  const valid = await resolveSavedStyle(statePath, styles);
  assert.equal(valid.activeStyle?.id, "learning");
  assert.deepEqual(valid.warnings, []);

  await writeFile(statePath, JSON.stringify({}));
  const invalidShape = await resolveSavedStyle(statePath, styles);
  assert.equal(invalidShape.activeStyle, undefined);
  assert.ok(
    invalidShape.warnings.some((warning) => warning.includes("state file")),
  );

  await writeFile(statePath, JSON.stringify({ style: 1 }));
  const invalidStyleType = await resolveSavedStyle(statePath, styles);
  assert.equal(invalidStyleType.activeStyle, undefined);
  assert.ok(
    invalidStyleType.warnings.some((warning) => warning.includes("state file")),
  );

  await writeFile(statePath, "{");
  const corrupt = await resolveSavedStyle(statePath, styles);
  assert.equal(corrupt.activeStyle, undefined);
  assert.ok(corrupt.warnings.some((warning) => warning.includes("state file")));

  await writeFile(statePath, JSON.stringify({ style: "deleted" }));
  const removed = await resolveSavedStyle(statePath, styles);
  assert.equal(removed.activeStyle, undefined);
  assert.ok(removed.warnings.some((warning) => warning.includes("deleted")));
});
