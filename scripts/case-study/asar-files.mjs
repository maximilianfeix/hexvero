// node asar-files.mjs <a> <b> : list JS/MJS files whose integrity hash or size differs, plus added/removed
import fs from 'node:fs';
function hdr(f){const fd=fs.openSync(f,'r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0);const n=b.readUInt32LE(12);const h=Buffer.alloc(n);fs.readSync(fd,h,0,n,16);return JSON.parse(h.toString());}
function walk(n,p,o){for(const[k,v]of Object.entries(n.files||{})){const q=p?p+'/'+k:k;if(v.files)walk(v,q,o);else o[q]=v;}return o;}
const [a,b]=process.argv.slice(2).map(f=>walk(hdr(f),'',{}));
let ch=0,same=0;for(const k of new Set([...Object.keys(a),...Object.keys(b)])){if(!/\.(m?js|cjs)$/.test(k))continue;const x=a[k],y=b[k];
if(!x)console.log('+',k,y.size,y.unpacked?'unpacked':'');else if(!y)console.log('-',k);else if((x.integrity?.hash)!==(y.integrity?.hash)||x.size!==y.size){ch++;}else same++;}
console.log('js changed',ch,'unchanged',same);
