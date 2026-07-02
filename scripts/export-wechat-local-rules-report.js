const fs = require('fs');
const path = require('path');

const INPUT_MD = path.resolve(__dirname, '../docs/wechat-local-rules-evaluation.md');
const OUTPUT_HTML = path.resolve(__dirname, '../docs/wechat-local-rules-evaluation.html');
const OUTPUT_TXT = path.resolve(__dirname, '../docs/wechat-local-rules-evaluation.txt');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function parseTable(lines, startIndex) {
  const rows = [];
  let index = startIndex;
  while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
    rows.push(lines[index].trim());
    index += 1;
  }

  const body = rows
    .filter((row, rowIndex) => rowIndex !== 1 || !/^\|[\s:\-|]+\|$/.test(row))
    .map((row, rowIndex) => {
      const cells = row.slice(1, -1).split('|').map((cell) => inlineMarkdown(cell.trim()));
      const tag = rowIndex === 0 ? 'th' : 'td';
      return `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`;
    })
    .join('\n');

  return {
    html: `<div class="table-wrap"><table>${body}</table></div>`,
    nextIndex: index
  };
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const html = [];
  let inCode = false;
  let codeLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      const table = parseTable(lines, index);
      html.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      html.push(`<p class="numbered">${inlineMarkdown(trimmed)}</p>`);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      const items = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      index -= 1;
      html.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }

  if (inCode && codeLines.length) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return html.join('\n');
}

function buildHtml(markdown) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] || 'WeChat local rule report';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      color: #1f2937;
      background: #f6f7f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      line-height: 1.65;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 24px 56px;
      background: #fff;
      min-height: 100vh;
      box-sizing: border-box;
    }
    h1 {
      margin: 0 0 18px;
      font-size: 30px;
      line-height: 1.25;
    }
    h2 {
      margin: 34px 0 12px;
      padding-top: 6px;
      border-top: 1px solid #e5e7eb;
      font-size: 22px;
    }
    h3 {
      margin: 26px 0 8px;
      font-size: 18px;
    }
    p, li {
      font-size: 15px;
    }
    code {
      padding: 2px 5px;
      border-radius: 4px;
      background: #f3f4f6;
      color: #111827;
      font-family: Consolas, "SFMono-Regular", monospace;
    }
    pre {
      overflow-x: auto;
      padding: 14px 16px;
      border-radius: 8px;
      background: #111827;
      color: #f9fafb;
      white-space: pre-wrap;
    }
    pre code {
      padding: 0;
      background: transparent;
      color: inherit;
    }
    .table-wrap {
      overflow-x: auto;
      margin: 14px 0 22px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      background: #f9fafb;
      font-weight: 700;
      white-space: nowrap;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .numbered {
      margin-left: 4px;
    }
  </style>
</head>
<body>
  <main>
${markdownToHtml(markdown)}
  </main>
</body>
</html>
`;
}

function main() {
  const markdown = fs.readFileSync(INPUT_MD, 'utf8').replace(/^\uFEFF/, '');
  fs.writeFileSync(OUTPUT_TXT, `\uFEFF${markdown}`, 'utf8');
  fs.writeFileSync(OUTPUT_HTML, `\uFEFF${buildHtml(markdown)}`, 'utf8');
  console.log(`Wrote ${OUTPUT_HTML}`);
  console.log(`Wrote ${OUTPUT_TXT}`);
}

main();
