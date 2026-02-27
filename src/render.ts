import type { AuditResponse, AuditResultItem, AuditViolation, CompareResponse, CompareItem } from "./api";

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

// --- Compare comment ---

function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  if (delta === 0) return "±0";
  return delta > 0 ? `+${formatBytes(delta)}` : `-${formatBytes(Math.abs(delta))}`;
}

function compareItemRow(
  item: CompareItem,
  violationMap: Map<string, AuditViolation>,
  showPrevious: boolean
): string {
  const gzip = item.status === "ok" ? formatBytes(item.gzip) : "—";
  const prev = showPrevious
    ? item.previous_gzip != null
      ? formatBytes(item.previous_gzip)
      : "—"
    : null;
  const delta = item.status === "ok" ? formatDelta(item.gzip_delta) : "—";

  let result: string;
  if (item.status !== "ok") {
    result = `⚠️ ${item.status}`;
  } else if (!item.pass) {
    const v = violationMap.get(item.package);
    result = v ? `❌ over by ${formatBytes(v.over_by)}` : "❌";
  } else {
    result = "✅";
  }

  const cells = showPrevious
    ? [`\`${item.package}\``, prev ?? "—", gzip, delta, result]
    : [`\`${item.package}\``, gzip, delta, result];

  return `| ${cells.join(" | ")} |`;
}

export function renderCompareComment(compare: CompareResponse): string {
  const { pass, added, changed, removed, violations, summary } = compare;

  const violationMap = new Map(
    violations.filter((v) => v.package !== "(total)").map((v) => [v.package, v])
  );
  const totalViolation = violations.find((v) => v.package === "(total)");

  const heading = pass
    ? "## ✅ BundleCheck — no size regressions"
    : "## ❌ BundleCheck — size budget violated";

  const lines: string[] = [COMMENT_MARKER, heading, ""];

  // Added section
  if (added.length > 0) {
    lines.push(`### Added (${added.length})`);
    lines.push("| Package | Gzip | Delta | Result |");
    lines.push("|---|---|---|---|");
    for (const item of added) {
      lines.push(compareItemRow(item, violationMap, false));
    }
    lines.push("");
  }

  // Changed section
  if (changed.length > 0) {
    lines.push(`### Changed (${changed.length})`);
    lines.push("| Package | Before | After | Delta | Result |");
    lines.push("|---|---|---|---|---|");
    for (const item of changed) {
      lines.push(compareItemRow(item, violationMap, true));
    }
    lines.push("");
  }

  // Removed section (no sizes — just listing)
  if (removed.length > 0) {
    lines.push(`### Removed (${removed.length})`);
    lines.push("| Package |");
    lines.push("|---|");
    for (const item of removed) {
      lines.push(`| \`${item.package}\` |`);
    }
    lines.push("");
  }

  // Summary row
  const deltaStr = formatDelta(summary.total_gzip_delta);
  const totalResult = totalViolation
    ? `❌ over by ${formatBytes(totalViolation.over_by)}`
    : summary.added_count + summary.changed_count > 0
    ? "✅"
    : "—";

  lines.push(`**Total new gzip:** ${formatBytes(summary.total_new_gzip)} (delta: ${deltaStr}) ${totalResult}`);
  lines.push("");
  lines.push(`> ⚠️ \`total_gzip\` is the **sum of individual package costs** — not your real app bundle size.`);

  if (summary.warning) {
    lines.push(`> ⚠️ ${summary.warning}`);
  }

  return lines.join("\n");
}
