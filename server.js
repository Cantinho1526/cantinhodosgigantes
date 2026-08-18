const express=require("express");
const path=require("path");
const {Pool}=require("pg");
const QRCode=require("qrcode");
const app=express(),PORT=process.env.PORT||3000;
if(!process.env.DATABASE_URL){console.error("DATABASE_URL ausente");process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
app.use(express.json());app.use(express.static(path.join(__dirname,"public")));

async function init(){
 await pool.query(`CREATE TABLE IF NOT EXISTS settings(id int primary key,name text not null,welcome text not null);
 CREATE TABLE IF NOT EXISTS categories(id serial primary key,name text unique not null);
 CREATE TABLE IF NOT EXISTS products(id serial primary key,name text not null,description text default '',price numeric(10,2) not null,category_id int references categories(id),emoji text default '🍔',image text default '',active boolean default true);
 CREATE TABLE IF NOT EXISTS tables_restaurant(id serial primary key,number int unique not null);
 CREATE TABLE IF NOT EXISTS orders(id serial primary key,table_number int not null,status text default 'Recebido',observation text default '',total numeric(10,2) not null,created_at timestamptz default now());
 CREATE TABLE IF NOT EXISTS order_items(id serial primary key,order_id int references orders(id) on delete cascade,product_id int references products(id),product_name text not null,quantity int not null,unit_price numeric(10,2) not null);`);
 await pool.query(`INSERT INTO settings(id,name,welcome) VALUES(1,'Cantinho dos Gigantes','Bem-vindo! Faça seu pedido pelo celular.') ON CONFLICT(id) DO NOTHING`);
 let c=(await pool.query("select count(*)::int c from categories")).rows[0].c;
 if(!c) await pool.query(`insert into categories(name) values('Lanches'),('Porções'),('Bebidas'),('Sobremesas')`);
 let t=(await pool.query("select count(*)::int c from tables_restaurant")).rows[0].c;
 if(!t) for(let i=1;i<=12;i++) await pool.query("insert into tables_restaurant(number) values($1) on conflict do nothing",[i]);
 let p=(await pool.query("select count(*)::int c from products")).rows[0].c;
 if(!p){
   let cats=Object.fromEntries((await pool.query("select id,name from categories")).rows.map(x=>[x.name,x.id]));
   for(const x of [
    ["X-Burger","Pão, hambúrguer, queijo e molho especial.",25.9,cats["Lanches"],"🍔"],
    ["X-Bacon","Hambúrguer, queijo e bacon.",28.9,cats["Lanches"],"🥓"],
    ["Batata Frita","Porção crocante.",15.9,cats["Porções"],"🍟"],
    ["Refrigerante","Lata 350 ml.",6.9,cats["Bebidas"],"🥤"],
    ["Brownie","Brownie quentinho.",12.9,cats["Sobremesas"],"🍫"]])
      await pool.query("insert into products(name,description,price,category_id,emoji) values($1,$2,$3,$4,$5)",x);
 }
}
app.get("/api/menu",async(req,res)=>{try{
 let settings=(await pool.query("select name,welcome from settings where id=1")).rows[0];
 let categories=(await pool.query("select id,name from categories order by id")).rows;
 let products=(await pool.query("select p.*,c.name category from products p join categories c on c.id=p.category_id where p.active=true order by p.id")).rows;
 res.json({settings,categories,products});
}catch(e){res.status(500).json({error:"Erro ao carregar cardápio"})}});
app.get("/api/admin/products",async(req,res)=>{let r=await pool.query("select p.*,c.name category from products p join categories c on c.id=p.category_id where p.active=true order by p.id desc");res.json(r.rows)});
app.post("/api/orders",async(req,res)=>{const {table,items,observation=""}=req.body;if(!Number(table)||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Pedido inválido"});
 const c=await pool.connect();try{await c.query("begin");let total=0,a=[];for(const i of items){let q=Math.max(1,Math.floor(Number(i.quantity))),r=await c.query("select id,name,price from products where id=$1 and active=true",[Number(i.product_id)]);if(!r.rowCount)throw Error("Produto inválido");let p=r.rows[0],price=Number(p.price);a.push({p,q,price});total+=price*q}
 let o=(await c.query("insert into orders(table_number,observation,total) values($1,$2,$3) returning id",[Number(table),String(observation),total])).rows[0];
 for(const x of a) await c.query("insert into order_items(order_id,product_id,product_name,quantity,unit_price) values($1,$2,$3,$4,$5)",[o.id,x.p.id,x.p.name,x.q,x.price]);
 await c.query("commit");res.json({ok:true,id:o.id,total});}catch(e){await c.query("rollback");res.status(400).json({error:"Erro ao criar pedido"})}finally{c.release()}});
app.get("/api/orders",async(req,res)=>{let os=(await pool.query("select * from orders order by id desc")).rows;for(const o of os)o.items=(await pool.query("select product_name name,quantity,unit_price from order_items where order_id=$1 order by id",[o.id])).rows;res.json(os)});
app.patch("/api/orders/:id",async(req,res)=>{let ok=["Recebido","Em preparo","Pronto","Entregue","Cancelado"];if(!ok.includes(req.body.status))return res.status(400).json({error:"Status inválido"});await pool.query("update orders set status=$1 where id=$2",[req.body.status,Number(req.params.id)]);res.json({ok:true})});
app.post("/api/products",async(req,res)=>{let x=req.body;if(!x.name||!Number(x.price)||!Number(x.category_id))return res.status(400).json({error:"Campos obrigatórios"});let r=await pool.query("insert into products(name,description,price,category_id,emoji,image) values($1,$2,$3,$4,$5,$6) returning id",[x.name,x.description||"",Number(x.price),Number(x.category_id),x.emoji||"🍔",x.image||""]);res.json(r.rows[0])});
app.put("/api/products/:id",async(req,res)=>{let x=req.body;await pool.query("update products set name=$1,description=$2,price=$3,category_id=$4,emoji=$5,image=$6 where id=$7",[x.name,x.description||"",Number(x.price),Number(x.category_id),x.emoji||"🍔",x.image||"",Number(req.params.id)]);res.json({ok:true})});
app.delete("/api/products/:id",async(req,res)=>{try{let r=await pool.query("update products set active=false where id=$1 returning id,name",[Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:"Produto não encontrado"});res.json({ok:true,product:r.rows[0]})}catch(e){console.error(e);res.status(500).json({error:"Erro ao excluir produto"})}});
app.post("/api/categories",async(req,res)=>{try{let r=await pool.query("insert into categories(name) values($1) returning id,name",[String(req.body.name||"").trim()]);res.json(r.rows[0])}catch(e){res.status(409).json({error:"Categoria já existe"})}});
app.put("/api/settings",async(req,res)=>{await pool.query("update settings set name=$1,welcome=$2 where id=1",[req.body.name||"Cantinho dos Gigantes",req.body.welcome||""]);res.json({ok:true})});
app.get("/api/qrcode/:table",async(req,res)=>{let url=`${req.protocol}://${req.get("host")}/?mesa=${encodeURIComponent(req.params.table)}`;res.json({url,png:await QRCode.toDataURL(url,{width:400,margin:2})})});
app.get("/api/stats",async(req,res)=>{let o=(await pool.query("select count(*)::int c,coalesce(sum(total),0) total from orders")).rows[0],p=(await pool.query("select count(*)::int c from products")).rows[0].c,t=(await pool.query("select count(*)::int c from tables_restaurant")).rows[0].c;res.json({orders:o.c,total:Number(o.total),products:p,tables:t})});
app.get("/health",async(req,res)=>{try{await pool.query("select 1");res.json({ok:true,database:"connected"})}catch(e){res.status(500).json({ok:false})}});
init().then(()=>app.listen(PORT,()=>console.log("Rodando na porta "+PORT))).catch(e=>{console.error(e);process.exit(1)});
