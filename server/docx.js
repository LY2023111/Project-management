/* 周报 Markdown → Word(.docx)
   只覆盖周报里实际会出现的语法：标题、加粗、行内代码、无序/有序列表、表格、引用、分隔线、段落。
   输出真正的 .docx（可被 Word / WPS 打开编辑），不依赖 Office 环境。 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, Footer,
} = require("docx");

const FONT = "微软雅黑";
const COLOR_TEXT = "1F2937";
const COLOR_SUB = "6B7280";
const COLOR_LINE = "E5E7EB";

/* 行内语法：**粗体**、`代码` */
function inlineRuns(text, opts) {
  const o = opts || {};
  const s = String(text == null ? "" : text);
  const runs = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  const push = (t, extra) => {
    if (!t) return;
    runs.push(new TextRun(Object.assign({
      text: t, font: FONT, size: o.size || 21, color: o.color || COLOR_TEXT,
    }, extra || {})));
  };
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) push(tok.slice(2, -2), { bold: true });
    else push(tok.slice(1, -1), { font: "Consolas", color: "374151" });
    last = m.index + tok.length;
  }
  push(s.slice(last));
  if (!runs.length) push("");
  return runs;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
const isTableSep = (line) => /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

function buildTable(rows) {
  const head = rows[0] || [];
  const body = rows.slice(1);
  const cols = Math.max(head.length, ...body.map((r) => r.length), 1);
  const cell = (text, isHead) => new TableCell({
    shading: isHead ? { type: ShadingType.CLEAR, fill: "F2F5F9" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { before: 0, after: 0, line: 260 },
      children: isHead
        ? [new TextRun({ text: String(text), bold: true, font: FONT, size: 19, color: "111827" })]
        : inlineRuns(text, { size: 19 }),
    })],
  });
  const mkRow = (cells, isHead) => new TableRow({
    tableHeader: isHead,
    children: Array.from({ length: cols }, (_, i) => cell(cells[i] == null ? "" : cells[i], isHead)),
  });
  const border = { style: BorderStyle.SINGLE, size: 4, color: COLOR_LINE };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [mkRow(head, true)].concat(body.map((r) => mkRow(r, false))),
  });
}

/* markdown 文本 → docx 段落/表格数组 */
function mdToBlocks(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (!line.trim()) { i++; continue; }

    /* 分隔线 */
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(new Paragraph({
        spacing: { before: 80, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR_LINE, space: 1 } },
        children: [new TextRun({ text: "", size: 2 })],
      }));
      i++; continue;
    }

    /* 标题 */
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) {
        blocks.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 160 },
          children: [new TextRun({ text, bold: true, font: FONT, size: 36, color: "111827" })],
        }));
      } else {
        blocks.push(new Paragraph({
          heading: level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: level === 2 ? 260 : 180, after: 100 },
          children: [new TextRun({
            text, bold: true, font: FONT,
            size: level === 2 ? 26 : 22,
            color: level === 2 ? "111827" : "374151",
          })],
          border: level === 2
            ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB", space: 4 } }
            : undefined,
        }));
      }
      i++; continue;
    }

    /* 表格 */
    if (line.trim().startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!isTableSep(lines[i])) rows.push(splitRow(lines[i]));
        i++;
      }
      if (rows.length) blocks.push(buildTable(rows));
      blocks.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "", size: 2 })] }));
      continue;
    }

    /* 引用 */
    if (/^\s*>\s?/.test(line)) {
      const text = line.replace(/^\s*>\s?/, "");
      blocks.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        indent: { left: 240 },
        shading: { type: ShadingType.CLEAR, fill: "EEF2FF" },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: "6366F1", space: 6 } },
        children: inlineRuns(text, { color: "3730A3", size: 20 }),
      }));
      i++; continue;
    }

    /* 无序列表 */
    if (/^\s*[-*+]\s+/.test(line)) {
      const indent = (line.match(/^\s*/) || [""])[0].length >= 2 ? 1 : 0;
      blocks.push(new Paragraph({
        bullet: { level: Math.min(indent, 2) },
        spacing: { before: 30, after: 30, line: 300 },
        children: inlineRuns(line.replace(/^\s*[-*+]\s+/, "")),
      }));
      i++; continue;
    }

    /* 有序列表 */
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      blocks.push(new Paragraph({
        spacing: { before: 30, after: 30, line: 300 },
        indent: { left: 240, hanging: 240 },
        children: [new TextRun({ text: ol[1] + ". ", font: FONT, size: 21, bold: true, color: "374151" })]
          .concat(inlineRuns(ol[2])),
      }));
      i++; continue;
    }

    /* 普通段落（连续行合并） */
    const buf = [line.trim()];
    i++;
    while (i < lines.length) {
      const n = lines[i];
      if (!n.trim()) break;
      if (/^\s*(#{1,6}\s|\||>|[-*+]\s|\d+[.)]\s)/.test(n)) break;
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(n)) break;
      buf.push(n.trim());
      i++;
    }
    const text = buf.join(" ");
    const isMeta = /^\*\*[^*]+\*\*$/.test(text); // 单独一行的加粗，如「周期：…」
    blocks.push(new Paragraph({
      spacing: { before: isMeta ? 0 : 60, after: isMeta ? 140 : 60, line: 320 },
      alignment: isMeta ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: inlineRuns(text, { size: isMeta ? 20 : 21, color: isMeta ? COLOR_SUB : COLOR_TEXT }),
    }));
  }
  return blocks;
}

/* 生成 docx Buffer */
async function markdownToDocxBuffer(md, meta) {
  const m = meta || {};
  const children = mdToBlocks(md);
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });

  const doc = new Document({
    creator: "项目管理工作台",
    title: m.title || "项目周报",
    description: "由项目管理工作台自动生成",
    styles: {
      default: {
        document: { run: { font: FONT, size: 21, color: COLOR_TEXT } },
        heading1: { run: { font: FONT, size: 36, bold: true, color: "111827" } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: "111827" } },
        heading3: { run: { font: FONT, size: 22, bold: true, color: "374151" } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({
              text: `${m.footer || "项目管理工作台"} · 导出于 ${stamp}`,
              font: FONT, size: 16, color: "9CA3AF",
            })],
          })],
        }),
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

/* 文件名：项目名-周报-起_止.docx（去掉文件系统非法字符） */
function reportFileName(projectName, weekStart, weekEnd) {
  const clean = String(projectName || "项目").replace(/[\\/:*?"<>|\r\n\t]/g, "").slice(0, 60);
  return `${clean}周报_${weekStart}_${weekEnd}.docx`;
}

/* AI 生成的周报从二级标题开始（页面已有标题），导出 Word 时补一个正式标题 */
function ensureTitle(md, projectName, weekStart, weekEnd) {
  const s = String(md || "");
  if (/^\s*#\s+/m.test(s)) return s;
  const head = `# ${projectName || "项目"} 项目周报`;
  const meta = weekStart && weekEnd ? `\n**周期：${weekStart} 至 ${weekEnd}**\n` : "";
  return `${head}${meta}\n${s}`;
}

module.exports = { markdownToDocxBuffer, mdToBlocks, reportFileName, ensureTitle };
