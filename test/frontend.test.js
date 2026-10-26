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
