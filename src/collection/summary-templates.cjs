const fs = require('node:fs');
const path = require('node:path');
const readTemplate = name => fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8').replace(/\r\n/g, '\n').trim();
const content = readTemplate('内容理解.md');
const evidenceNotes = readTemplate('证据笔记.md');
const evidenceLedger = readTemplate('终稿证据清单.md');
const evidenceReview = readTemplate('终稿证据核对.md');
const styleTutorial = readTemplate('蒸馏提示词教程.md');
const templates = Object.freeze({
  article: { type: '文章精读', prompt: content },
  content: { type: '内容理解', prompt: content },
  style: { type: '画面与视频制作拆解', prompt: readTemplate('画面分析.md') }
});
module.exports = { templates, evidenceNotes, evidenceLedger, evidenceReview, styleTutorial };
