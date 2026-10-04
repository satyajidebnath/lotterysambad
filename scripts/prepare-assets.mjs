import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('public/vendor',{recursive:true});
await copyFile('index.html','public/index.html');
for(const name of ['pdf.min.mjs','pdf.worker.min.mjs'])await copyFile(`vendor/${name}`,`public/vendor/${name}`);
console.log('Prepared website and local PDF.js renderer.');
