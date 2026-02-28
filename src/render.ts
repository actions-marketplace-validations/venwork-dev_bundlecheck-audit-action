import type { AuditResponse, AuditResultItem, AuditViolation } from "./api";

export const COMMENT_MARKER = "<!-- bundlecheck-audit -->";

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function statusCell(item: AuditResultItem): string {
  const emoji: Record<AuditResultItem["status"], string> = {
    ok: "✅",
    denied: "⛔",
    not_found: "🔍",
    timeout: "⏱️",
    error: "❌",
  };
  return `${emoji[item.status]} ${item.status}`;
}

function resultCell(
  item: AuditResultItem,
  violationMap: Map<string, AuditViolation>
): string {
  if (item.status !== "ok") return "—";
  if (!item.pass) {
    const v = violationMap.get(item.package);
    return v ? `❌ over by ${formatBytes(v.over_by)}` : "❌";
  }
  return "✅";
}

export function renderComment(audit: AuditResponse): string {
  const { pass, results, violations, summary } = audit;

  const violationMap = new Map(
    violations.filter((v) => v.package !== "(total)").map((v) => [v.package, v])
  );
  const totalViolation = violations.find((v) => v.package === "(total)");

  const heading = pass
    ? "## ✅ BundleCheck — all packages within budget"
    : "## ❌ BundleCheck — budget violations detected";

  const tableRows = results.map((item) => {
    const gzip = item.status === "ok" ? formatBytes(item.gzip) : "—";
    return `| \`${item.package}\` | ${gzip} | ${statusCell(item)} | ${resultCell(item, violationMap)} |`;
  });

  const totalResultCell = totalViolation
    ? `❌ over by ${formatBytes(totalViolation.over_by)}`
    : summary.ok_count > 0
    ? "✅"
    : "—";

  const table = [
    "| Package | Gzip | Status | Result |",
    "|---|---|---|---|",
    ...tableRows,
    `| **Total** | **${formatBytes(summary.total_gzip)}** | | ${totalResultCell} |`,
  ].join("\n");

  const lines: string[] = [
    COMMENT_MARKER,
    heading,
    "",
    table,
    "",
    `> ⚠️ \`total_gzip\` is the **sum of individual package costs** — not your real app bundle size (deduplication and tree-shaking are not accounted for).`,
  ];

  if (summary.skipped_count > 0) {
    lines.push(
      `> ℹ️ ${summary.skipped_count} package${summary.skipped_count > 1 ? "s" : ""} skipped (denied, not found, or errored).`
    );
  }

  if (summary.warning) {
    lines.push(`> ⚠️ ${summary.warning}`);
  }

  return lines.join("\n");
}

// --- Deps comment (package.json-based compare) ---

interface AddedDep { name: string; version: string }
interface ChangedDep { name: string; version: string; previousSpec: string }
interface RemovedDep { name: string }

export interface DepsCommentData {
  added: AddedDep[];
  changed: ChangedDep[];
  removed: RemovedDep[];
  audit: AuditResponse | null;
  addedNames: Set<string>;
}

function extractPackageName(nameAtVersion: string): string {
  // @scope/pkg@1.0.0 → @scope/pkg,  pkg@1.0.0 → pkg
  if (nameAtVersion.startsWith("@")) {
    const rest = nameAtVersion.slice(1);
    const afterSlash = rest.slice(rest.indexOf("/") + 1);
    const atIdx = afterSlash.indexOf("@");
    return atIdx !== -1 ? `@${rest.slice(0, rest.indexOf("/") + 1)}${afterSlash.slice(0, atIdx)}` : nameAtVersion;
  }
  return nameAtVersion.split("@")[0];
}

function auditResultCell(name: string, resultByName: Map<string, AuditResultItem>, violationByName: Map<string, AuditViolation>): string {
  const item = resultByName.get(name);
  if (!item) return "—";
  if (item.status !== "ok") return `⚠️ ${item.status}`;
  const v = violationByName.get(name);
  return v ? `❌ over by ${formatBytes(v.over_by)}` : "✅";
}

export function renderDepsComment(data: DepsCommentData): string {
  const { added, changed, removed, audit } = data;

  const resultByName = new Map<string, AuditResultItem>();
  const violationByName = new Map<string, AuditViolation>();

  if (audit) {
    for (const item of audit.results) {
      resultByName.set(extractPackageName(item.package), item);
    }
    for (const v of audit.violations.filter((v) => v.package !== "(total)")) {
      violationByName.set(extractPackageName(v.package), v);
    }
  }

  const totalViolation = audit?.violations.find((v) => v.package === "(total)");
  const pass = !audit || audit.pass;
  const heading = pass
    ? "## ✅ BundleCheck — no size regressions"
    : "## ❌ BundleCheck — size budget violated";

  const lines: string[] = [COMMENT_MARKER, heading, ""];

  if (added.length > 0) {
    lines.push(`### Added (${added.length})`);
    lines.push("| Package | Version | Gzip | Result |");
    lines.push("|---|---|---|---|");
    for (const dep of added) {
      const item = resultByName.get(dep.name);
      const gzip = item?.status === "ok" ? formatBytes(item.gzip) : "—";
      lines.push(`| \`${dep.name}\` | ${dep.version} | ${gzip} | ${auditResultCell(dep.name, resultByName, violationByName)} |`);
    }
    lines.push("");
  }

  if (changed.length > 0) {
    lines.push(`### Updated (${changed.length})`);
    lines.push("| Package | Version | Gzip | Result |");
    lines.push("|---|---|---|---|");
    for (const dep of changed) {
      const item = resultByName.get(dep.name);
      const gzip = item?.status === "ok" ? formatBytes(item.gzip) : "—";
      const prevVersion = dep.previousSpec.replace(/^[\^~>=<v]+/, "").split(/\s*\|\|\s*/)[0].split(/\s+/)[0];
      lines.push(`| \`${dep.name}\` | ${prevVersion} → ${dep.version} | ${gzip} | ${auditResultCell(dep.name, resultByName, violationByName)} |`);
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Removed (${removed.length})`);
    lines.push("| Package |");
    lines.push("|---|");
    for (const dep of removed) {
      lines.push(`| \`${dep.name}\` |`);
    }
    lines.push("");
  }

  if (audit && audit.summary.ok_count > 0) {
    const totalResult = totalViolation ? `❌ over by ${formatBytes(totalViolation.over_by)}` : "✅";
    lines.push(`**Total gzip: ${formatBytes(audit.summary.total_gzip)}** ${totalResult}`);
    lines.push("");
    lines.push(`> ⚠️ \`total_gzip\` is the sum of individual package costs — not your real app bundle size.`);
  }

  return lines.join("\n");
}
