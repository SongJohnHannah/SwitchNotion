import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
const sharp=require(process.env.SHARP_MODULE || 'sharp');
const root=path.dirname(fileURLToPath(import.meta.url));
const records=JSON.parse(await fs.readFile(path.join(root,'generation-manifest.json'),'utf8'));
const verification=[];
for(const record of records){
  if(!record.path)throw new Error(`Missing generated page ${record.page}`);
  const name=String(record.page).padStart(2,'0');
  const original=path.join(root,'generated',`page-${name}.png`);
  await fs.copyFile(record.path,original);
  const metadata=await sharp(original).metadata();
  const output=path.join(root,'images',`page-${name}.png`);
  // Generation follows the requested aspect ratio. Normalize the small raster-size
  // rounding difference to the user's exact delivery dimensions, without adding bars.
  await sharp(original).resize(1242,1660,{fit:'fill',kernel:'lanczos3'}).png({compressionLevel:9}).toFile(output);
  const result=await sharp(output).metadata();
  if(result.width!==1242 || result.height!==1660)throw new Error(`Invalid size on page ${name}`);
  verification.push({page:record.page,file:`images/page-${name}.png`,generatedDimensions:[metadata.width,metadata.height],dimensions:[result.width,result.height]});
}
const tiles=await Promise.all(verification.map(async(record,index)=>({
  input:await sharp(path.join(root,record.file)).resize(248,332).toBuffer(),
  left:16+(index%5)*264,top:16+Math.floor(index/5)*348
})));
await sharp({create:{width:1336,height:712,channels:3,background:'#e4e7df'}}).composite(tiles).jpeg({quality:94}).toFile(path.join(root,'contact-sheet.jpg'));
await fs.writeFile(path.join(root,'尺寸核验.json'),JSON.stringify({count:verification.length,width:1242,height:1660,pages:verification},null,2));
await fs.writeFile(path.join(root,'重排提示词.txt'),'内置图像编辑工具逐页重排。下列为最终采用的提示词。\n\n'+records.map(record=>`第 ${record.page} 页\n${record.prompt}`).join('\n\n'));
console.log(JSON.stringify(verification,null,2));
