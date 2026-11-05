/* 周报 Word 导出单测：Markdown → .docx（zip 包结构、块类型、文件名清洗） */
const test = require("node:test");
const assert = require("node:assert");
const { Table, Paragraph } = require("docx");
const { markdownToDocxBuffer, mdToBlocks, reportFileName, ensureTitle } = require("../server/docx");

const MD = [
  "# 郏县妇幼 项目周报",
  "**周期：2026-10-26 至 2026-11-01**",
  "",
  "## 一、本周概览",
  "- 项目整体进度：55%（8 个上线模块平均）",
  "- 本周有进度更新的模块：3 / 8",
  "",
  "## 二、模块进展",
  "| 模块 | 状态 | 上周进度 | 本周进度 | 变化 |",
  "| --- | --- | --- | --- | --- |",
  "| 门诊挂号 | 开发中 | 20% | 55% | +35% |",
  "| 住院结算 | 测试中 | 40% | 60% | +20% |",
  "",
  "## 三、问题与需求",
  "**本周新增（2 条）**",
  "- [Bug] 缴费后状态未回写｜优先级 高",
  "",
  "1. 第一步",
  "2. 第二步",
  "",
  "> 需要医院协调医保接口",
  "",
  "---",
  "结尾段落。",
].join("\n");

test("Word 导出：产出合法 docx（zip 容器 + 正文/样式/页脚）", async () => {
  const buf = await markdownToDocxBuffer(MD, { title: "测试周报" });
  assert.equal(buf.slice(0, 2).toString("latin1"), "PK", "docx 是 zip");
  assert.ok(buf.length > 3000, "包体大小合理：" + buf.length);
  assert.ok(buf.includes("word/document.xml"), "含正文");
  assert.ok(buf.includes("word/styles.xml"), "含样式");
  assert.ok(buf.includes("word/footer1.xml"), "含页脚");
  assert.ok(buf.includes("[Content_Types].xml"), "含内容类型表");
});

test("Word 导出：表格/标题/列表/引用都被识别成对应块", () => {
  const blocks = mdToBlocks(MD);
  const tables = blocks.filter((b) => b instanceof Table);
  const paras = blocks.filter((b) => b instanceof Paragraph);
  assert.equal(tables.length, 1, "识别出 1 个表格");
  assert.equal(tables[0].rows.length, 3, "表格 1 表头 + 2 数据行");
  assert.equal(tables[0].rows[0].root.length, 6, "6 列（首列为表头单元格）");
  assert.ok(paras.length >= 8, "其余内容都变成段落：" + paras.length);
});

test("Word 导出：空内容不报错，仍能生成文档", async () => {
  const buf = await markdownToDocxBuffer("", {});
  assert.equal(buf.slice(0, 2).toString("latin1"), "PK");
});

test("Word 标题：AI 版没有一级标题时自动补项目名与周期", () => {
  const ai = "## 一、本周概览\n- 整体进度 30%";
  const out = ensureTitle(ai, "郏县妇幼", "2026-10-26", "2026-11-01");
  assert.ok(out.startsWith("# 郏县妇幼 项目周报"), "补标题：" + out.split("\n")[0]);
  assert.ok(out.includes("**周期：2026-10-26 至 2026-11-01**"), "补周期");
  assert.ok(out.includes("## 一、本周概览"), "原文保留");

  // 已有标题的不重复添加
  const withTitle = "# 某项目 周报\n\n## 一、本周概览";
  assert.equal(ensureTitle(withTitle, "郏县妇幼", "2026-10-26", "2026-11-01"), withTitle);
});

test("Word 文件名：去掉文件系统非法字符并带上周期", () => {
  assert.equal(
    reportFileName("郏县妇幼", "2026-10-26", "2026-11-01"),
    "郏县妇幼周报_2026-10-26_2026-11-01.docx"
  );
  const dirty = reportFileName('郏县/妇幼:项目*?<>|"', "2026-10-26", "2026-11-01");
  assert.ok(!/[\\/:*?"<>|]/.test(dirty), "不含非法字符：" + dirty);
  assert.ok(dirty.endsWith(".docx"));
  assert.ok(reportFileName("", "2026-10-26", "2026-11-01").startsWith("项目周报_"), "空项目名有兜底");
});
