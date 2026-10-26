const test=require('node:test');
const assert=require('node:assert/strict');
const {databaseConfig,commandSession,validCommandSession,imageReference}=require('../security');

test('sessão de atendimento não vale para outro cliente/atendimento ou comanda',()=>{
  const token=commandSession('secret',42,'A001');
  assert(validCommandSession('secret',token,42,'A001'));
  for(const [id,code,secret] of [[43,'A001','secret'],[42,'A002','secret'],[42,'A001','other']]){
    assert(!validCommandSession(secret,token,id,code));
  }
  for(const invalid of ['',token+'x',token.slice(1),null,'x'.repeat(10000)])assert(!validCommandSession('secret',invalid,42,'A001'));
});
test('banco exige CA no Aiven e não aceita desativar TLS pela URI',()=>{
  assert.throws(()=>databaseConfig('postgres://u:p@demo.aivencloud.com:123/db',{}),/DATABASE_CA_CERT/);
  const c=databaseConfig('postgres://u:p@demo.aivencloud.com:123/db?sslmode=disable&sslrootcert=wrong&application_name=test',{DATABASE_CA_CERT:'A\\nB'});
  assert.equal(c.ssl.rejectUnauthorized,true);
  assert.equal(c.ssl.ca,'A\nB');
  const u=new URL(c.connectionString);
  assert(!u.searchParams.has('sslmode'));assert(!u.searchParams.has('sslrootcert'));
  assert.equal(u.searchParams.get('application_name'),'test');
});
test('imagens grandes saem do JSON com URL versionada e formatos ativos são rejeitados',()=>{
  const image='data:image/png;base64,'+Buffer.from('image').toString('base64');
  const ref=imageReference(image,7);
  assert.match(ref,/^\/api\/products\/7\/image\?v=[a-f0-9]{16}$/);
  assert.notEqual(ref,imageReference(image+'AAAA',7));
  assert.equal(imageReference('javascript:alert(1)',7),'');
  assert.equal(imageReference('data:image/svg+xml,<svg onload=x>',7),'');
  assert.equal(imageReference('//evil.test/p.png',7),'');
  assert.equal(imageReference('https://example.com/p.png',7),'https://example.com/p.png');
});
