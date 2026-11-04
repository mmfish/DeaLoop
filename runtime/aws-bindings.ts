import {SQLiteDatabase} from './sqlite';
import {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3';
import {join} from 'node:path';

let database: SQLiteDatabase|undefined;
const s3 = new S3Client({region:process.env.AWS_REGION || 'us-west-2'});
function bucket() { const name = process.env.DEALOOP_BUCKET; if (!name) throw Error('Photo storage is not configured'); return name; }
const storage = {
  async put(id:string, body:Uint8Array, options?:{httpMetadata?:{contentType?:string}}) {
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:'images/'+id,Body:body,ContentType:options?.httpMetadata?.contentType}));
  },
  async get(id:string) {
    try {
      const value = await s3.send(new GetObjectCommand({Bucket:bucket(),Key:'images/'+id}));
      return {body:value.Body?.transformToWebStream(),httpMetadata:{contentType:value.ContentType}};
    } catch (error) { if ((error as {name?:string}).name === 'NoSuchKey') return null; throw error; }
  },
  async delete(id:string) {
    await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:'images/'+id}));
  },
};
// Lazy initialization keeps the build from opening or modifying a runtime DB.
export const env = {
  get DB(): D1Database {
    if (!database) {
      database = new SQLiteDatabase(process.env.DEALOOP_DB_PATH || join(process.cwd(),'data/dealoop.sqlite'));
      database.migrate(process.env.DEALOOP_MIGRATIONS_PATH || join(process.cwd(),'drizzle'));
    }
    return database.asD1();
  },
  get BUCKET(): R2Bucket { return storage as unknown as R2Bucket; },
};
