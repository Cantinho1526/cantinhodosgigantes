const crypto=require('node:crypto');
const fs=require('node:fs');

function databaseConfig(raw,env=process.env){
  const url=new URL(raw);
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert','channel_binding'])url.searchParams.delete(key);
  const ca=env.DATABASE_CA_CERT?.replace(/\\n/g,'\n') ||
    (env.DATABASE_CA_FILE?fs.readFileSync(env.DATABASE_CA_FILE,'utf8'):undefined);
  if(url.hostname.endsWith('.aivencloud.com')&&!ca){
    throw Error('Configure DATABASE_CA_CERT ou DATABASE_CA_FILE com o certificado CA do Aiven antes de publicar.');
  }
  return {connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(ca?{ca}:{})},
    enableChannelBinding:true,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000};
}
function commandSession(secret,accountId,code){
  const body=Buffer.from(JSON.stringify({account_id:Number(accountId),code})).toString('base64url');
  return body+'.'+crypto.createHmac('sha256',secret).update('command-session:'+body).digest('base64url');
}
function validCommandSession(secret,token,accountId,code){
  if(typeof token!=='string'||token.length>512)return false;
  const expected=commandSession(secret,accountId,code);
  const a=Buffer.from(token),b=Buffer.from(expected);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function imageReference(image,id){
  const value=String(image||'');
  if(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value)){
    return '/api/products/'+Number(id)+'/image?v='+crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
  }
  if(/^https?:\/\//i.test(value)||/^\/(?!\/)/.test(value))return value;
  return '';
}
module.exports={databaseConfig,commandSession,validCommandSession,imageReference};
