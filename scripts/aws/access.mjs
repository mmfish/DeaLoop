// Short-lived AWS-issued SSH material stays in an owner-only native SSH directory.
// No credentials are printed or passed as shell arguments.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const [instance,profile='yiyadmin',region='us-west-2']=process.argv.slice(2);
if(!instance||!/^[a-z0-9-]+$/.test(instance))throw Error('Provide instance name');
const data=JSON.parse(execFileSync('aws',['lightsail','get-instance-access-details','--instance-name',instance,'--profile',profile,'--region',region,'--output','json'],{encoding:'utf8'})).accessDetails;
const directory=join(homedir(),'.config/dealoop-deploy');mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
writeFileSync(join(directory,'ssh-key'),data.privateKey,{mode:0o600});chmodSync(join(directory,'ssh-key'),0o600);
writeFileSync(join(directory,'ssh-key-cert.pub'),data.certKey,{mode:0o600});
if(!data.hostKeys?.length)throw Error('AWS did not supply SSH host keys');
writeFileSync(join(directory,'known_hosts'),data.hostKeys.map(k=>{
 const bytes=Buffer.from(k.publicKey,'base64');const algorithm=bytes.subarray(4,4+bytes.readUInt32BE(0)).toString();
 if(!['ssh-ed25519','ssh-rsa','ecdsa-sha2-nistp256'].includes(algorithm))throw Error('Unsupported host key');
 return data.ipAddress+' '+algorithm+' '+k.publicKey;
}).join('\n')+'\n',{mode:0o600});
writeFileSync(join(directory,'connection.json'),JSON.stringify({host:data.ipAddress,user:data.username,expiresAt:data.expiresAt}),{mode:0o600});
console.log(JSON.stringify({host:data.ipAddress,user:data.username,expiresAt:data.expiresAt,directory}));
