const fs = require('node:fs');
const path = require('node:path');
const readTemplate = name => fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8').replace(/\r\n/g, '\n').trim();
const content = readTemplate('content-understanding.md');
const evidenceNotes = readTemplate('evidence-notes.md');
const evidenceLedger = readTemplate('final-evidence-ledger.md');
const evidenceReview = readTemplate('final-evidence-review.md');
const styleTutorial = readTemplate('distilled-prompt-tutorial.md');
const templates = Object.freeze({
  article: { type: '文章精读', prompt: content },
  content: { type: '内容理解', prompt: content },
  style: { type: '画面与视频制作拆解', prompt: readTemplate('visual-analysis.md') }
});
module.exports = { templates, evidenceNotes, evidenceLedger, evidenceReview, styleTutorial };
