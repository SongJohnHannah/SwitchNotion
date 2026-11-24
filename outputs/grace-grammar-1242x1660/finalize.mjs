import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
const sharp=require(process.env.SHARP_MODULE || 'sharp');
const root=path.dirname(fileURLToPath(import.meta.url));
const records=JSON.parse(await fs.readFile(path.join(root,'generation-manifest.json'),'utf8'));
const names=['01-core-concept.png','02-compulsory-levels.png','03-high-school-levels.png','04-learning-methods.png'];
const checks=[];
for(const record of records){
  const name=names[record.page-1];
  const source=path.join(root,'generated',name);
  await fs.copyFile(record.path,source);
  const output=path.join(root,'images',name);
  await sharp(source).resize(1242,1660,{fit:'fill',kernel:'lanczos3'}).png({compressionLevel:9}).toFile(output);
  const metadata=await sharp(output).metadata();
  if(metadata.width!==1242 || metadata.height!==1660)throw new Error(`Invalid dimensions: ${name}`);
  checks.push({page:record.page,file:`images/${name}`,size:[metadata.width,metadata.height]});
}
const tiles=await Promise.all(checks.map(async(record,index)=>({
  input:await sharp(path.join(root,record.file)).resize(414,553).toBuffer(),
  left:20+(index%2)*434,top:20+Math.floor(index/2)*573
})));
await sharp({create:{width:888,height:1166,channels:3,background:'#dfe5dc'}}).composite(tiles).jpeg({quality:94}).toFile(path.join(root,'contact-sheet.jpg'));
await fs.writeFile(path.join(root,'尺寸核验.json'),JSON.stringify(checks,null,2));
await fs.writeFile(path.join(root,'制作提示词.txt'),'使用内置图像生成与编辑工具制作；最终交付为1242×1660像素PNG。\n\n'+records.map(record=>`第${record.page}张\n${record.prompt}${record.correction?'\n\n定向校正：'+record.correction:''}`).join('\n\n'));
console.log(JSON.stringify(checks,null,2));
