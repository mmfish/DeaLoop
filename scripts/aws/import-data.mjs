// Read a bounded, complete Sites export from stdin. Never log row values.
// Usage: node --experimental-strip-types scripts/aws/import-data.mjs [--dry-run] /private/path/dealoop.sqlite
import {SQLiteDatabase} from '../../runtime/sqlite.ts';
import {chmodSync} from 'node:fs';
const args=process.argv.slice(2),dryRun=args.includes('--dry-run'),filename=args.find(a=>!a.startsWith('--'));
if(!filename)throw Error('Destination is required');
const maxInputBytes=512*1024*1024;
let raw='';
if(process.stdin.isTTY){
 process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdout.write('Ready for hidden export JSON on stdin.\n');
 raw=await new Promise((resolve,reject)=>{process.stdin.on('data',function receive(chunk){raw+=chunk;if(raw.length>maxInputBytes)reject(Error('Export exceeds 512 MB'));if(raw.includes('\u0003'))reject(Error('Cancelled'));if(raw.includes('\n')){process.stdin.removeListener('data',receive);process.stdin.setRawMode(false);process.stdin.pause();resolve(raw.slice(0,raw.indexOf('\n')));}});});
}else{const chunks=[];let inputBytes=0;for await(const c of process.stdin){inputBytes+=c.length;if(inputBytes>maxInputBytes)throw Error('Export exceeds 512 MB');chunks.push(c);}raw=Buffer.concat(chunks).toString();}
const tables=JSON.parse(raw);
const order=['users','auth_identities','connections','posts','photos','offers','offer_revisions','messages','negotiation_actions','negotiation_events','deals','activities'];
if(!tables||typeof tables!=='object'||Array.isArray(tables))throw Error('Export must be an object of tables');
for(const name of order){
 const table=tables[name];
 if(!table||!Array.isArray(table.columns)||!Array.isArray(table.rows))throw Error('Malformed table '+name);
 if(table.columns.some(c=>typeof c!=='string'))throw Error('Malformed columns '+name);
 if(table.rows.length>1000000)throw Error('Table too large '+name);
 for(const row of table.rows){
  if(!row||typeof row!=='object'||Array.isArray(row))throw Error('Malformed row '+name);
  for(const value of Object.values(row)){
   if(value!==null&&typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')throw Error('Malformed value in '+name);
   if(typeof value==='string'&&value.length>1000000)throw Error('Value too large in '+name);
  }
 }
}
if(dryRun){console.log(JSON.stringify({dryRun:true,validated:order.map(table=>({table,rows:tables[table].rows.length,columns:tables[table].columns.length}))}));process.exit(0);}
const db=new SQLiteDatabase(filename);db.migrate('drizzle');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
try{
 if(db.raw.prepare('SELECT COUNT(*) n FROM users').get().n)throw Error('Destination is not empty');
 db.raw.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
 for(const name of order){
  const table=tables[name];if(!table)throw Error('Missing table '+name);
  const actual=db.raw.prepare('PRAGMA table_info('+quote(name)+')').all().map(c=>c.name);
  if(table.columns.some(c=>!actual.includes(c)))throw Error('Unknown column');
  for(const original of table.rows){
   const row={...original};
   // A new domain requires fresh agent enrollment. Preserve history but revoke old grants.
   if(name==='connections'){row.status='revoked';row.token_hash=null;}
   if(name==='users'&&row.id==='thread-demo')row.name='DeaLoop examples';
   if(name==='posts'&&row.demo)row.description=row.description.replaceAll('Thread','DeaLoop');
   const values=table.columns.map(c=>row[c]);
   db.raw.prepare('INSERT INTO '+quote(name)+' ('+table.columns.map(quote).join(',')+') VALUES ('+values.map(()=>'?').join(',')+')').run(...values);
  }
 }
 if(db.raw.prepare('PRAGMA foreign_key_check').all().length)throw Error('Foreign key validation failed');
 db.raw.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
 if(db.raw.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Integrity check failed');
 chmodSync(filename,0o600);
 console.log(JSON.stringify({imported:order.map(table=>({table,rows:tables[table].rows.length})),integrity:'ok',oldGrants:'revoked',sessions:'not copied'}));
}catch(error){if(db.raw.isTransaction)db.raw.exec('ROLLBACK');throw error;}finally{db.close();}
