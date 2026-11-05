// Produce an offline single-file PRIVATE view. Never copy it to a public release.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({ options: { input: { type:'string' }, out: { type:'string' } } });
if(!a.input || !a.out) throw new Error('node render.mjs --input SNAPSHOT.json --out NEW_PRIVATE.html');
const report=JSON.parse(fs.readFileSync(a.input,'utf8'));
if(report.schemaVersion!==1 || !Array.isArray(report.nodes)) throw new Error('Unsupported snapshot');
const json=JSON.stringify(report).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const template=fs.readFileSync(new URL('./viewer.html',import.meta.url),'utf8');
const output=template.replace('<!-- MEMORY_SHAPE_SNAPSHOT -->',()=>'<script type="application/json" id="memory-shape-snapshot">'+json+'</script>');
fs.writeFileSync(a.out,output,{flag:'wx',mode:0o600});
console.log('Private offline view: '+a.out);
