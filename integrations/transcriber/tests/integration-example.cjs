const fs = require('node:fs');
const operator = require(String.raw`D:\迅雷下载\notionSwitch\GPU转写算子\operator.cjs`);

(async () => {
  // WAV 须为接口支持的16kHz单声道格式；完整视频直接使用 transcribeFile。
  const session = operator.createSpeechSession();
  try {
    const text = await session.transcribeWav({
      wav: fs.readFileSync(process.argv[2]), language: 'en', chunkSeconds: 30,
    });
    fs.writeFileSync(process.argv[3], text, 'utf8');
  } finally {
    await session.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });