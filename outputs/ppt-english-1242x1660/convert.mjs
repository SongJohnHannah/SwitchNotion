import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const require=createRequire(import.meta.url);
const sharp=require(process.env.SHARP_MODULE || 'sharp');
const root=path.dirname(fileURLToPath(import.meta.url));
const dest=path.join(root,'images');
await fs.mkdir(dest,{recursive:true});
const slides=JSON.parse(await fs.readFile(path.join(root,'source-manifest.json'),'utf8'));
const width=1242;
const height=1660;
// Reproduce the picture placement from the PPTX XML on its original 16:9 slide.
// Each supplied slide is one full-width embedded PNG, with no crop or rotation.
const slideWidthEmu=16256000;
const slideHeightEmu=9144000;
const pictureTopEmu=38100;
const pictureHeightEmu=9067800;
const scale=width/slideWidthEmu;
const naturalHeight=Math.round(slideHeightEmu*scale);
const pictureHeight=Math.round(pictureHeightEmu*scale);
const slideTop=Math.floor((height-naturalHeight)/2);
const imageTop=slideTop+Math.round(pictureTopEmu*scale);
const results=[];

for(const slide of slides){
  const name=String(slide.page).padStart(2,'0');
  const image=await sharp(path.join(root,'source-images',`${name}.png`))
    .resize(width,pictureHeight,{fit:'fill',kernel:'lanczos3'})
    .toBuffer();
  const output=path.join(dest,`slide-${name}.png`);
  await sharp({create:{width,height,channels:3,background:'#ffffff'}})
    .composite([{input:image,left:0,top:imageTop}])
    .png({compressionLevel:9})
    .toFile(output);
  const metadata=await sharp(output).metadata();
  if(metadata.width!==width || metadata.height!==height)throw new Error(`Incorrect dimensions: ${name}`);
  results.push({page:slide.page,file:path.basename(output),width:metadata.width,height:metadata.height,slidePosition:[0,slideTop,width,naturalHeight],picturePosition:[0,imageTop,width,pictureHeight]});
}

const tiles=await Promise.all(results.map(async(item,index)=>({
  input:await sharp(path.join(dest,item.file)).resize(248,332).toBuffer(),
  left:16+(index%5)*264,
  top:16+Math.floor(index/5)*348
})));
await sharp({create:{width:1336,height:712,channels:3,background:'#e4e7df'}})
  .composite(tiles).jpeg({quality:93}).toFile(path.join(root,'contact-sheet.jpg'));
await fs.writeFile(path.join(root,'validation.json'),JSON.stringify({outputSize:[width,height],pages:results.length,mode:'Complete original slides centered on white portrait canvases',slides:results},null,2));
console.log(JSON.stringify({pages:results.length,size:[width,height],imagePlacement:{top:imageTop,height:pictureHeight},files:results.map(item=>item.file)},null,2));
