const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./model.cjs');
const { genericTemplate } = require('./prompts.cjs');

const MAX_TYPES = 100;
const MAX_TEMPLATE = 12000;
const MAX_FILE = 300 * 1024;

const builtin = Object.freeze({
  '教程': { type: '教程', title: '分步教程', template: `# 分步教程
定位：这是一份可以直接照着做的教程笔记。重点是还原可执行的步骤、参数和判断标准，而不是复述讲述过程。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析。区分「口述」「画面演示」「推断」；资料没给的步骤或参数不补造。
按以下结构输出简洁中文 Markdown：
## 一句话结论
这份教程最终能让人做出什么；需要哪些前提。
## 适用前提
适用对象、所需基础、设备或环境限制。
## 材料与工具
逐项列出材料、工具、软件版本或账号前提；没有提到的写「资料未说明」。
## 操作步骤
按实际执行顺序编号。每一步写清：
1. 做什么（动词开头）
2. 怎么做（工具、参数、时长、火候等具体值）
3. 做到什么程度算完成（可观察的结果）
画面里出现但口述没说的操作单独标注「画面可见」。
## 关键参数与判断标准
列出最容易出错或最影响结果的参数、阈值、时间和判断方法。
## 常见问题与注意事项
资料中提到的坑、限制、失败表现和补救方式；没有提到的不硬凑。
## 可执行清单
把整套流程压缩成可逐项勾选的清单。
## 待核实
资料中缺失、前后不一致或无法确认的内容，按重要性排序。` },
  '技能方法': { type: '技能方法', title: '技能方法', template: `# 技能方法
定位：这是一份关于「怎么做成一件事」的方法笔记。重点是方法、原理、练习路径和适用条件。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析；区分主张、例子和推断。
按以下结构输出简洁中文 Markdown：
## 一句话结论
这套方法解决什么问题、核心做法是什么。
## 方法框架
用 3–6 条说明方法的组成部分及其关系，避免流水账。
## 关键动作
把方法拆成可执行动作：做什么、怎么做、做到什么程度。
## 原理与依据
说明方法为什么有效、作者给出的证据或案例；没有证据的标为「作者判断」。
## 练习路径
如果真的要从不会到会用，按由易到难列出练习顺序和检验方式。
## 适用条件与反例
在什么条件下有效、什么情况下不适用或要打折扣。
## 常见误区
资料中提到的、或从方法本身可明确推出的误区。
## 待核实
缺失证据和无法确认的说法。` },
  '知识学习': { type: '知识学习', title: '知识学习', template: `# 知识学习
定位：这是一份知识型内容的笔记。重点是概念、结论、解释和例子，帮助读者建立可复用的理解。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析；区分事实、作者观点和推断。
按以下结构输出简洁中文 Markdown：
## 一句话结论
用一句大白话回答：这份内容最核心的知识点是什么。
## 核心概念
先定义术语，再用一句话说明它为什么重要；概念多时按依赖顺序排列。
## 关键要点
按重要性列 3–6 点，每点附资料中的证据、数字或例子。
## 费曼式解释
用 2–4 句大白话解释核心概念；用 1–2 个资料中的例子或类比；指出最容易误解的地方。
## 边界与反例
知识成立的边界、例外情况、常见误用。
## 与其他知识的关系
如果资料提到，说明它和已有概念、方法或工具的衔接；没提到就不写。
## 待核实
缺失证据、可能过时或无法确认的说法。` },
  '美食制作': { type: '美食制作', title: '美食制作', template: `# 美食制作
定位：这是一份可以照着复刻的菜谱笔记。重点是配料、用量、步骤、火候与判断标准。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析；资料没给的用量或时间写「资料未说明」，不补造。
按以下结构输出简洁中文 Markdown：
## 成品与口味
一句话说明成品是什么、口味和口感特点。
## 配料与用量
按主料、辅料、调料分组列清单；有具体用量时保留原始数字和单位。
## 预处理
切配、腌制、浸泡、预热等准备步骤和所需时间。
## 制作步骤
按实际顺序编号，每步写清：
1. 操作
2. 火候/温度/时间
3. 判断标准（颜色、声音、质地、气味）
## 关键控制点
最容易失败的环节、替代食材、火候调整和补救方法。
## 装盘与保存
装盘方式、趁热/冷却建议、保存时间和复热方法（仅资料提到时写）。
## 待核实
资料未说明的用量、时间和无法确认的说法。` },
  '评测开箱': { type: '评测开箱', title: '评测开箱', template: `# 评测开箱
定位：这是一份产品评测/开箱笔记。重点是结论、证据、优缺点和适用人群。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析；区分实测、参数和主观感受。
按以下结构输出简洁中文 Markdown：
## 一句话结论
值不值得买/用，适合谁。
## 产品与定位
是什么产品、面向什么需求、价格或版本信息（资料提到时）。
## 实测表现
按使用场景列出实测结果，保留数字、条件和限制。
## 优点
3–5 条，每条附证据。
## 缺点与限制
3–5 条，附证据；没有明显缺点时说明测试条件限制。
## 适合与不适合
分别说明适合和不适合的人群或场景。
## 购买建议
在什么价格/需求下值得考虑；资料没有价格时不编造。
## 待核实
无法确认的参数、主观判断和缺失测试。` },
  '访谈观点': { type: '访谈观点', title: '访谈观点', template: `# 访谈观点
定位：这是一份访谈/对谈/观点输出笔记。重点是核心观点、论据、分歧和可引用的表达。
依据：只使用本次提供的正文、逐字稿、关键帧文字和画面分析；区分说话人原话、转述和推断。
按以下结构输出简洁中文 Markdown：
## 一句话结论
这场访谈最重要的观点或信息是什么。
## 核心观点
按重要性列 3–6 条，标明是谁说的，保留关键原话。
## 论据与案例
每条观点对应的证据、经历或案例；没有证据的标为「个人判断」。
## 分歧与未回应
对话中出现分歧、回避或没有展开的问题。
## 口吻与风格
用 2–3 句话概括说话人的表达方式、立场和现场氛围（仅在有逐字稿或画面分析时写）。
## 可引用表达
3–5 句最有价值的原话，标明说话人。
## 待核实
事实性说法、缺失背景和无法确认的内容。` },
  '口播解说': { type: '口播解说', title: '口播解说', template: `# 口播解说
定位：这是一份以主播口播/解说为主的内容笔记。重点是讲了什么、怎么讲、风格如何。
依据：逐字稿代表口述内容，画面分析只代表关键帧。严格区分「口述」「画面可见」「推断」。
按以下结构输出简洁中文 Markdown：
## 一句话结论
这条内容最想让观众知道或记住什么。
## 讲述脉络
按顺序概括开场、展开、转折和收尾，只在资料给出时间点时标注时间。
## 关键信息
按重要性列 3–6 条，保留数字、人名和关键原话。
## 口吻与风格
概括语速、语气、立场、常用修辞、互动方式和情绪表达；说明依据来自逐字稿还是画面。
## 结构与节奏
开场钩子、信息密度、重复强调、转场方式。
## 可复用表达
3–5 句有代表性的原话或句式。
## 待核实
无法确认的事实、缺失画面或听不清的部分。` },
  'Vlog': { type: 'Vlog', title: '日常 Vlog', template: `# 日常 Vlog
定位：这是一份 Vlog/日常记录笔记。重点是叙事线、人物、地点和高光片段。
依据：只使用本次提供的逐字稿、关键帧文字和画面分析；区分口述与画面可见。
按以下结构输出简洁中文 Markdown：
## 一句话结论
这条 Vlog 记录了什么、给人什么感觉。
## 叙事线
按时间顺序概括主要段落，只在资料提供时标注时间。
## 人物与地点
出现的人物、关系和地点；不确定的身份不猜。
## 高光片段
3–6 个值得回看的瞬间，说明画面或原话依据。
## 画面与风格
镜头、色调、剪辑节奏、字幕和配乐风格（依据画面分析，不推断未看到的内容）。
## 可借鉴的表达
如果内容包含可复用的拍摄或叙事手法，单独列出。
## 待核实
无法确认的人物、地点或说法。` },
  '通用': { type: '通用', title: '通用总结', template: genericTemplate }
});

const builtinTypes = Object.freeze(Object.keys(builtin));

function normalizeType(value) {
  if (typeof value !== 'string') return '';
  const type = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!type || type.length > 40 || /[\\/]/.test(type) || type.includes('..')) return '';
  return type;
}
function validTemplate(value) {
  return typeof value === 'string' && value.trim().length >= 200 && value.length <= MAX_TEMPLATE && !value.includes('\0');
}
function libraryFile(root) { return path.join(root, 'collection', 'summary-templates.json'); }
function emptyLibrary() { return { version: 1, types: {} }; }
function normalizeEntry(type, entry) {
  const key = normalizeType(type);
  if (!key || !entry || typeof entry !== 'object' || normalizeType(entry.type) !== key || !validTemplate(entry.template)) return null;
  return { type: key, title: String(entry.title || key).slice(0, 80), template: entry.template,
    revision: Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1,
    source: entry.source === 'builtin' ? 'builtin' : 'deepseek',
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}) };
}
function loadLibrary(root) {
  const file = libraryFile(root);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) return emptyLibrary();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || !value.types || typeof value.types !== 'object' || Array.isArray(value.types)) return emptyLibrary();
    const types = {};
    for (const [key, entry] of Object.entries(value.types).slice(0, MAX_TYPES)) {
      const normalized = normalizeEntry(key, entry);
      if (normalized) types[normalized.type] = normalized;
    }
    return { version: 1, types };
  } catch { return emptyLibrary(); }
}
function saveLibrary(root, library) {
  const types = {};
  for (const [key, entry] of Object.entries(library?.types || {}).slice(0, MAX_TYPES)) {
    const normalized = normalizeEntry(key, entry);
    if (normalized) types[normalized.type] = normalized;
  }
  atomicJson(libraryFile(root), { version: 1, types });
  return { version: 1, types };
}
function resolveTemplate(library, type) {
  const key = normalizeType(type);
  if (!key) return null;
  const saved = library?.types?.[key];
  if (saved) return { ...saved };
  const fallback = builtin[key];
  return fallback ? { ...fallback } : null;
}
function knownTypes(library) {
  return [...new Set([...builtinTypes, ...Object.keys(library?.types || {})])];
}

module.exports = { builtin, builtinTypes, normalizeType, validTemplate, libraryFile, emptyLibrary, loadLibrary, saveLibrary, resolveTemplate, knownTypes };
