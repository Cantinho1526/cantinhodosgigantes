const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const localRequire=createRequire(require('node:path').resolve('server.js'));
const secret='test-table-secret';
const account={id:42,table_number:1001,status:'Aberta',account_type:'Comanda QR',customer_name:'A001',customer_full_name:'Pessoa Exemplo'};
function harness(query){
 const routes=new Map();
 const app={set(){},use(){},listen(){},get(path,...h){routes.set('GET '+path,h)},post(path,...h){routes.set('POST '+path,h)},put(){},patch(){},delete(){}};
 const express=()=>app;express.json=express.static=()=>()=>{};
 class Pool{on(){} async query(sql,args){return query(sql,args)} async connect(){return {query:this.query.bind(this),release(){}}}}
 const context=vm.createContext({require(n){if(n==='express')return express;if(n==='pg')return {Pool};return localRequire(n)},
   process:{env:{ADMIN_PIN:'123456',ADMIN_SESSION_SECRET:'test-admin-secret',TABLE_QR_SECRET:secret,DATABASE_URL:'postgres://u:p@localhost/db'},exit(){throw Error('exit')}},
   __dirname:require('node:path').resolve('.'),Buffer,URL,console:{error(){},warn(){},log(){}},setInterval(){return {unref(){}}},setTimeout,clearTimeout,AbortController,fetch});
 const source=fs.readFileSync('server.js','utf8');vm.runInContext(source.slice(0,source.lastIndexOf('\ninit()')),context);
 return {routes,context};
}
function qrToken(){return crypto.createHmac('sha256',secret).update('command:A001').digest('hex').slice(0,32)}
function response(){return {statusCode:200,status(n){this.statusCode=n;return this},json(data){this.data=data;return this},sendStatus(n){this.statusCode=n;return this},set(){return this}}}
function readDb(sql){if(sql.includes('from table_accounts'))return {rows:[account],rowCount:1};if(sql.includes('from orders'))return {rows:[]};return {rows:[],rowCount:0}}
test('QR estático sozinho não revela nome nem pedidos da comanda ativa',async()=>{
 const h=harness(readDb),res=response();
 await h.routes.get('GET /api/client/command/:code').at(-1)({params:{code:'A001'},query:{t:qrToken()},headers:{}},res);
 assert.equal(res.statusCode,403);assert(!JSON.stringify(res.data).includes(account.customer_full_name));
});
test('sessão correta consulta a comanda, sessão antiga é bloqueada',async()=>{
 const {commandSession}=require('../security');
 for(const id of [41,42]){
  const h=harness(readDb),res=response();
  await h.routes.get('GET /api/client/command/:code').at(-1)({params:{code:'A001'},query:{t:qrToken()},headers:{'x-command-session':commandSession(secret,id,'A001')}},res);
  assert.equal(res.statusCode,id===42?200:403);
 }
});
test('saber o nome completo não permite assumir atendimento já aberto',async()=>{
 const h=harness(sql=>sql.includes('cash_sessions')?{rows:[{id:1}]}:readDb(sql)),res=response();
 await h.routes.get('POST /api/client/command-identification/:code').at(-1)({params:{code:'A001'},query:{},headers:{},body:{token:qrToken(),customer_full_name:account.customer_full_name}},res);
 assert.equal(res.statusCode,403);assert.equal(res.data.session_token,undefined);
});
test('novo atendimento com caixa aberto recebe sessão própria',async()=>{
 const h=harness(sql=>{
  if(sql.includes('cash_sessions'))return {rows:[{id:1}]};
  if(sql.includes('insert into table_accounts'))return {rows:[account]};
  return {rows:[],rowCount:0};
 }),res=response();
 await h.routes.get('POST /api/client/command-identification/:code').at(-1)({params:{code:'A001'},query:{},headers:{},body:{token:qrToken(),customer_full_name:account.customer_full_name}},res);
 assert.equal(res.statusCode,200);assert(require('../security').validCommandSession(secret,res.data.session_token,account.id,'A001'));
});
test('cliente antigo não cria pedido após encerramento da sua sessão',async()=>{
 const h=harness(sql=>sql.includes('cash_sessions')?{rows:[{id:1}]}:{rows:[],rowCount:0}),res=response();
 await h.routes.get('POST /api/orders').at(-1)({headers:{},body:{command_code:'A001',access_token:qrToken(),request_id:'a-valid-request-key-123',customer_full_name:account.customer_full_name,items:[{product_id:1,quantity:1}]}},res);
 assert.equal(res.statusCode,403);
});
test('rotas administrativas negam token ausente e fechamento rejeita dinheiro/cartão',async()=>{
 const h=harness(readDb);
 for(const path of ['POST /api/accounts/:id/close','POST /api/admin/pix/reconcile','GET /api/admin/qr-commands/:code/session']){
  const res=response();let passed=false;await h.routes.get(path)[0]({headers:{}},res,()=>{passed=true});assert.equal(res.statusCode,401);assert(!passed);
 }
 for(const method of ['Dinheiro','Cartão']){
  const res=response();await h.routes.get('POST /api/accounts/:id/close').at(-1)({body:{payment_method:method}},res);assert.equal(res.statusCode,400);
 }
});
test('reconciliação percorre os registros antigos e pode focar o pagamento notificado',async()=>{
 let seen;const h=harness((sql,args)=>{seen={sql,args};return {rows:[]}});
 await vm.runInContext('reconcilePaidPixAccounts(55)',h.context);
 assert.match(seen.sql,/last_checked_at asc nulls first/);assert.equal(seen.args[0],55);
 const res=response();await h.routes.get('POST /api/admin/pix/reconcile').at(-1)({},res);assert.equal(res.statusCode,200);
});
test('PIX antigo não pode ser consultado com a sessão de outro atendimento',async()=>{
 const {commandSession}=require('../security');let calls=0;
 const h=harness(sql=>{calls++;return {rows:[{id:5,account_id:42,account_type:'Comanda QR',customer_name:'A001',table_number:1001}]}}),res=response();
 await h.routes.get('GET /api/client/pix/:id/status').at(-1)({params:{id:'5'},query:{t:qrToken()},headers:{'x-command-session':commandSession(secret,41,'A001')}},res);
 assert.equal(res.statusCode,404);assert.equal(calls,1);
});
test('identificação não abre comanda enquanto o caixa está fechado',async()=>{
 let insert=false;const h=harness(sql=>{if(sql.includes('insert'))insert=true;return {rows:[],rowCount:0}}),res=response();
 await h.routes.get('POST /api/client/command-identification/:code').at(-1)({params:{code:'A001'},query:{},headers:{},body:{token:qrToken(),customer_full_name:account.customer_full_name}},res);
 assert.equal(res.statusCode,409);assert(!insert);
});
test('custos preservam venda histórica, vínculo por ID e unidades parcialmente cobertas',()=>{
 const h=harness(readDb);
 const result=vm.runInContext(`calculateSalesCosts([
 {product_name:'Produto renomeado',product_id:1,quantity:1,unit_price:12,unit_cost:4},
 {product_name:'Misto',product_id:2,quantity:1,unit_price:10,unit_cost:3},
 {product_name:'Misto',product_id:2,quantity:2,unit_price:10,unit_cost:0},
 {product_name:'Atual',product_id:3,quantity:2,unit_price:8,unit_cost:0}
 ],[{id:1,cost_price:9},{id:2,cost_price:0},{id:3,cost_price:2}],[])`,h.context);
 assert.equal(result.financial.known_cost,11);
 assert.equal(result.financial.known_revenue,38);
 assert.equal(result.financial.missing_revenue,20);
 assert.equal(result.financial.missing_items,2);
 assert.equal(result.products.find(x=>x.name==='Misto').missing_items,2);
});
test('custo histórico sem produto, associação e exclusão usam a mesma base',()=>{
 const h=harness(readDb);
 const result=vm.runInContext(`calculateSalesCosts([
 {product_name:'Água antiga',quantity:1,unit_price:12,unit_cost:0},
 {product_name:'Coração',quantity:2,unit_price:10,unit_cost:0},
 {product_name:'Teste',quantity:1,unit_price:5,unit_cost:2}
 ],[{id:9,cost_price:3}],[
 {normalized_name:'agua antiga',historical_unit_cost:4},
 {normalized_name:'coracao',alias_product_id:9},
 {normalized_name:'teste',ignored:true}
 ])`,h.context);
 assert.equal(result.financial.known_cost,10);
 assert.equal(result.financial.known_revenue,32);
 assert.equal(result.financial.missing_items,0);
 assert.equal(result.financial.ignored_revenue,5);
});
test('relatórios diário e por período retornam os mesmos custos sem alterar recebimentos',async()=>{
 const h=harness((sql,args)=>{
  if(sql.includes('select oi.product_name,oi.product_id')){
   assert.deepEqual(Array.from(args),['2026-09-29','2026-09-29']);
   assert(sql.includes("o.status<>'Cancelado'"));
   return {rows:[{product_name:'Antigo',product_id:1,quantity:1,unit_price:12,unit_cost:4}]};
  }
  if(sql==='select id,cost_price from products')return {rows:[{id:1,cost_price:99}]};
  if(sql.includes('profit_historical_rules')||sql.includes('cash_sessions'))return {rows:[]};
  if(sql.includes('count(*)::int contas'))return {rows:[{pix:12,dinheiro:0,cartao:0,total:12,contas:1}]};
  if(sql.includes('from table_accounts'))return {rows:[{id:1,payment_method:'PIX',closed_at:'2026-09-29T18:00:00Z',total:12,order_count:1,mercado_pago_verified:true}]};
  throw Error(sql);
 });
 for(const route of ['period','daily']){
  const res=response();
  await h.routes.get('GET /api/reports/'+route).at(-1)({query:{start:'2026-09-29',end:'2026-09-29',date:'2026-09-29'}},res);
  assert.equal(res.statusCode,200);assert.equal(res.data.summary.total,12);
  assert.equal(res.data.summary.custo,4);assert.equal(res.data.summary.lucro_bruto_parcial,8);
  assert.equal(res.data.summary.itens_sem_custo,0);
 }
});
