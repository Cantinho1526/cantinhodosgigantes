const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function frontend(){
 const source=[...fs.readFileSync('public/index.html','utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('function renderMenu'));
 const elements=new Map();const storage=new Map();
 const node=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',classList:{toggle(){},contains(){return false}},style:{},addEventListener(){}});return elements.get(id)};
 const context=vm.createContext({document:{getElementById:node,addEventListener(){}},window:{addEventListener(){}},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{search:'',hash:'',pathname:'/'},history:{replaceState(){}},URLSearchParams,URL,Intl,console,setTimeout(){},setInterval(){},clearInterval(){},fetch(){throw Error('Network disabled in tests')},alert(){},confirm(){return false}});
 new vm.Script(source);vm.runInContext(source.slice(0,source.lastIndexOf('\nclient();')),context);
 return {context,elements};
}
test('busca sem acentos combina com categoria e não altera o carrinho',()=>{
 const h=frontend();vm.runInContext(`M={products:[{id:1,name:'Água com gás',description:'Gelada',category:'Bebidas',price:5,image:'/photo.png'},{id:2,name:'Bolo',category:'Doces',price:8}]};B=[{product_id:2,quantity:1,price:8}];menuSearch='agua';C='Todos';renderMenu();`,h.context);
 let html=h.elements.get('products').innerHTML;assert(html.includes('Água com gás'));assert(!html.includes('Bolo'));assert(html.includes('loading="lazy"'));
 assert.equal(vm.runInContext('B.length',h.context),1);
 vm.runInContext(`C='Doces';renderMenu();`,h.context);assert(h.elements.get('products').innerHTML.includes('Nenhum produto'));
});
test('PIX envia autorização do atendimento pelo cabeçalho, sem colocá-la na URL',async()=>{
 const h=frontend();let request;
 h.context.location.search='?comanda=A001&t=static';
 h.context.sessionStorage.setItem('cg_command_session_A001','temporary');
 h.context.fetch=async(url,opts)=>{request={url,opts};return {ok:true,status:200,text:async()=>'{}'}};
 await vm.runInContext(`api('/api/client/pix/1/status?t=static')`,h.context);
 assert.equal(request.opts.headers['X-Command-Session'],'temporary');assert(!request.url.includes('temporary'));
});
test('painel usa cobertura do servidor e não perde custo histórico ao renomear produto',async()=>{
 const h=frontend();
 h.context.fetch=async url=>({ok:true,status:200,text:async()=>JSON.stringify(
 url.includes('/reports/')?{summary:{total:32,custo:7,faturamento_com_custo:22,faturamento_sem_custo:10,itens_sem_custo:1, cobertura_custos:68.75, lucro_bruto_parcial:15},products:[
 {name:'Nome antigo',quantity:1,total:12,known_cost:4,known_revenue:12,missing_items:0,missing_revenue:0,cost_product_id:1},
 {name:'Misto',quantity:2,total:20,known_cost:3,known_revenue:10,missing_items:1,missing_revenue:10,cost_product_id:2}
 ]}:url.includes('/admin/products')?[{id:1,name:'Nome novo',cost_price:99},{id:2,name:'Misto',cost_price:0}]:[])});
 await vm.runInContext(`profitPanel('2026-09-06','2026-10-26')`,h.context);
 const html=h.elements.get('adminContent').innerHTML;
 assert(html.includes('68,8%'));assert(html.includes('15,00'));
 const missing=html.slice(html.indexOf('Produtos vendidos sem custo'),html.indexOf('Produtos vendidos no período'));
 assert(!missing.includes('Nome antigo'));assert(missing.includes('Misto'));assert(missing.includes('<td>1</td>'));
});
