const fs = require('node:fs');
const path = require('node:path');
const readTemplate = name => fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8').replace(/\r\n/g, '\n').trim();
const [article, media] = readTemplate('内容理解.md').split('\n<!-- collection:media -->\n');
const templates = Object.freeze({
  article: { type: '文章精读', prompt: article.trim() },
  content: { type: '内容理解', prompt: media.trim() },
  style: { type: '画面与视频制作拆解', prompt: readTemplate('画面分析.md') }
});
module.exports = { templates };
