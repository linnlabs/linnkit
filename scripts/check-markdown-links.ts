/**
 * 全仓 Markdown 链接检查（CI 运行）：仓库内链接不能越出仓库根，目标必须在仓库里，锚点必须存在。
 *
 * `docs/integration` 随 npm 包发布而 `src` 不发布，所以接入文档要引用源码时写 GitHub 绝对地址，
 * 不写指向 `src/` 的相对链接；绝对地址属于外部链接，这里不检查。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import {
  createMarkdownRepository,
  findMarkdownLinkProblems,
  type MarkdownLinkProblemReason,
} from './markdownLocalLinks.ts';

const REASON_TEXT: Record<MarkdownLinkProblemReason, string> = {
  'invalid-link': '链接无法解析',
  'outside-repository': '指向仓库外',
  'missing-target': '目标不在仓库里',
  'missing-anchor': '标题锚点不存在',
};

function gitFiles(args: readonly string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/** 工作区里实际存在的自有文件：已跟踪与未忽略的新文件，去掉已从工作区删除的跟踪文件。 */
function listWorkingTreeFiles(): string[] {
  const deleted = new Set(gitFiles(['--deleted']));
  return [...new Set(gitFiles(['--cached', '--others', '--exclude-standard']))].filter(file => !deleted.has(file));
}

const files = listWorkingTreeFiles();
const repository = createMarkdownRepository(files, file => fs.readFileSync(file, 'utf8'));
const markdownFiles = files.filter(file => file.endsWith('.md'));
const problems = markdownFiles.flatMap(file => findMarkdownLinkProblems(file, fs.readFileSync(file, 'utf8'), repository));

if (problems.length === 0) {
  console.log(`[check-markdown-links] 通过：${markdownFiles.length} 份 Markdown 的仓库内链接均有效。`);
} else {
  console.error('[check-markdown-links] Markdown 仓库内链接失效：');
  for (const problem of problems) {
    console.error(`  ${problem.file}:${problem.line} ${REASON_TEXT[problem.reason]}：${problem.destination}`);
  }
  process.exitCode = 1;
}
