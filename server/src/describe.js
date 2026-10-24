// Plain-English explanation of what a file is, from its name, extension and
// folder. Used by the "what can agents see" picker so teams know what they're
// sharing. GitHub's tree API has no file contents, so this is rule-based.

const BY_NAME = [
  [/^package\.json$/, "Project manifest: name, scripts and the libraries it depends on"],
  [/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/, "Lockfile: pins the exact version of every dependency"],
  [/^readme(\..*)?$/i, "Readme: what the project is and how to use it"],
  [/^(license|licence|copying)(\..*)?$/i, "License: the legal terms for using this code"],
  [/^(changelog|history)(\..*)?$/i, "Changelog: history of what changed in each release"],
  [/^contributing(\..*)?$/i, "Guide for people who want to contribute"],
  [/^\.gitignore$/, "Tells git which files not to track"],
  [/^\.gitattributes$/, "Git settings for line endings and file handling"],
  [/^\.env(\..*)?$/, "Environment variables: often holds passwords and API keys"],
  [/^\.npmrc$/, "npm settings (may contain a registry token)"],
  [/^\.nvmrc$|^\.node-version$/, "Which Node.js version the project uses"],
  [/^\.editorconfig$/, "Editor formatting rules (tabs, spaces, line endings)"],
  [/^(\.prettierrc.*|prettier\.config\..*)$/, "Prettier settings: how code is auto-formatted"],
  [/^(\.eslintrc.*|eslint\.config\..*)$/, "ESLint settings: code style and bug-catching rules"],
  [/^tsconfig.*\.json$/, "TypeScript compiler settings"],
  [/^jsconfig\.json$/, "JavaScript editor/import settings"],
  [/^(vite|vitest)\.config\..*$/, "Vite config: how the app is built and served in development"],
  [/^next\.config\..*$/, "Next.js config"],
  [/^webpack\.config\..*$/, "Webpack config: how the code is bundled"],
  [/^(babel\.config\..*|\.babelrc.*)$/, "Babel config: how modern JavaScript is compiled"],
  [/^tailwind\.config\..*$/, "Tailwind CSS theme and settings"],
  [/^postcss\.config\..*$/, "PostCSS config: CSS processing plugins"],
  [/^(jest|karma|playwright|cypress)\.config\..*$/, "Test runner config"],
  [/^\.mocharc.*$/, "Mocha test runner config"],
  [/^dockerfile$/i, "Docker recipe: how to build a container image of the app"],
  [/^(docker-)?compose\.ya?ml$|^docker-compose\.ya?ml$/, "Docker Compose: runs the app and its services together"],
  [/^\.dockerignore$/, "Files Docker should skip when building"],
  [/^makefile$/i, "Make tasks: shortcuts for building and running"],
  [/^procfile$/i, "Tells the host which command starts the app"],
  [/^(vercel|netlify)\.(json|toml)$/, "Deployment settings for the hosting platform"],
  [/^requirements.*\.txt$/, "Python dependencies list"],
  [/^(pyproject\.toml|setup\.py|setup\.cfg)$/, "Python project and packaging settings"],
  [/^go\.(mod|sum)$/, "Go module dependencies"],
  [/^cargo\.(toml|lock)$/i, "Rust package and dependencies"],
  [/^index\.html$/, "Web page entry point: the HTML the browser loads first"],
  // Next.js / app-router conventions
  [/^page\.[jt]sx?$/, "Page: what users see at this URL"],
  [/^layout\.[jt]sx?$/, "Layout: shared wrapper (header, nav) around pages"],
  [/^route\.[jt]s$/, "API endpoint: handles requests to this URL"],
  [/^loading\.[jt]sx?$/, "Loading screen shown while the page loads"],
  [/^(error|not-found)\.[jt]sx?$/, "Error page shown when something goes wrong"],
  [/^middleware\.[jt]s$/, "Middleware: runs before every request"],
  [/^globals?\.css$/, "Global styles for the whole app"],
  [/^favicon\.ico$/, "Browser tab icon"],
  [/^(main|index|app|server)\.(js|mjs|cjs|ts|jsx|tsx)$/, "Entry point: where the program starts running"],
];

const BY_EXT = {
  js: "JavaScript source code", mjs: "JavaScript module", cjs: "JavaScript (CommonJS) module",
  ts: "TypeScript source code", jsx: "React component (JavaScript)", tsx: "React component (TypeScript)",
  vue: "Vue component", svelte: "Svelte component",
  py: "Python source code", rb: "Ruby source code", go: "Go source code", rs: "Rust source code",
  java: "Java source code", kt: "Kotlin source code", cs: "C# source code", php: "PHP source code",
  c: "C source code", cpp: "C++ source code", h: "C/C++ header", swift: "Swift source code",
  css: "Stylesheet: how the page looks", scss: "Sass stylesheet", less: "Less stylesheet",
  html: "HTML page", md: "Markdown documentation", mdx: "Markdown page with components", txt: "Plain text",
  json: "JSON data or settings", yml: "YAML settings", yaml: "YAML settings", toml: "TOML settings", xml: "XML data",
  sql: "Database query or schema", prisma: "Prisma database schema", graphql: "GraphQL schema or query",
  sh: "Shell script", ps1: "PowerShell script", bat: "Windows batch script",
  png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image", svg: "Vector image / icon", ico: "Site icon",
  woff: "Font", woff2: "Font", ttf: "Font", otf: "Font",
  mp4: "Video", mp3: "Audio", wav: "Audio", pdf: "PDF document", csv: "Spreadsheet data (CSV)",
  pem: "Certificate or private key", key: "Private key", lock: "Lockfile",
};

// Folder names that say what the code inside is for.
const BY_FOLDER = [
  [/^(components?|ui|widgets)$/, "UI component"],
  [/^(pages|views|screens)$/, "Page / screen"],
  [/^(routes?|controllers?|handlers?|endpoints?)$/, "Route handler: answers requests"],
  [/^api$/, "API code"],
  [/^(models?|schemas?|entities)$/, "Data model"],
  [/^(utils?|helpers?|lib|common|shared)$/, "Helper / utility code"],
  [/^hooks$/, "React hook (reusable component logic)"],
  [/^(services?|clients?)$/, "Service: talks to outside systems"],
  [/^(middlewares?)$/, "Middleware: runs on every request"],
  [/^(store|state|redux|slices)$/, "App state management"],
  [/^(styles?|css)$/, "Styling"],
  [/^(assets?|static|public|images?|img|icons?)$/, "Static asset"],
  [/^(config|configs?|settings)$/, "Configuration"],
  [/^(scripts?|bin|tools)$/, "Helper script"],
  [/^(migrations?)$/, "Database migration"],
  [/^(docs?|documentation)$/, "Documentation"],
  [/^(fixtures?|__mocks__|mocks?)$/, "Test data / mock"],
];

export function describeFile(relPath) {
  const parts = relPath.split("/");
  const name = parts.at(-1);
  const lower = name.toLowerCase();

  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    const subject = name.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, "");
    return `Automated tests for ${subject}`;
  }
  if (parts[0] === ".github" && parts[1] === "workflows") return "CI workflow: what GitHub Actions runs on each push or PR";
  if (parts[0] === ".github") return "GitHub settings (templates, ownership, bots)";
  if (parts[0] === ".vscode") return "VS Code editor settings for this project";

  for (const [re, text] of BY_NAME) if (re.test(lower) || re.test(name)) return text;

  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  const base = BY_EXT[ext] ?? (ext ? `.${ext} file` : "File");

  // Code files get a more specific label from the folder they live in,
  // e.g. "UI component (React, JavaScript)".
  const folderHint = parts.slice(0, -1).reverse().map((p) => BY_FOLDER.find(([re]) => re.test(p.toLowerCase()))?.[1]).find(Boolean);
  if (folderHint && LANGUAGE[ext]) return `${folderHint} (${LANGUAGE[ext]})`;
  if (folderHint && /asset|test data|documentation/i.test(folderHint)) return `${folderHint}: ${base.toLowerCase()}`;
  return base;
}

const LANGUAGE = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript",
  jsx: "React, JavaScript", tsx: "React, TypeScript", vue: "Vue", svelte: "Svelte",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#", php: "PHP", swift: "Swift",
};
