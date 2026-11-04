import {DatabaseSync} from 'node:sqlite';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {readFileSync,rmSync,mkdtempSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const bucket=process.env.DEALOOP_BUCKET,filename=process.env.DEALOOP_DB_PATH;
if(!bucket||!filename)throw Error('DEALOOP_BUCKET and DEALOOP_DB_PATH are required');
const directory=mkdtempSync(join(tmpdir(),'dealoop-backup-')),copy=join(directory,'snapshot.sqlite');
const db=new DatabaseSync(filename),s3=new S3Client({region:process.env.AWS_REGION||'us-west-2'});
try{
 db.exec('PRAGMA busy_timeout=5000');
 db.prepare('VACUUM INTO ?').run(copy);chmodSync(copy,0o600);
 const snapshot=new DatabaseSync(copy,{readOnly:true});
 if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity check failed');
 snapshot.close();
 // Seven rotating daily slots bound retained backup storage. Bucket versioning must stay disabled.
 const key='backups/day-'+new Date().getUTCDay()+'.sqlite';
 await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:readFileSync(copy),ContentType:'application/vnd.sqlite3',ServerSideEncryption:'AES256'}));
 const check=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
 if(!Buffer.from(await check.Body.transformToByteArray()).equals(readFileSync(copy)))throw Error('Uploaded backup verification failed');
 console.log(JSON.stringify({backup:key,verified:true}));
}finally{db.close();rmSync(directory,{recursive:true,force:true});}
