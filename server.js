const express=require("express");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");
const QRCode=require("qrcode");

const app=express();
const PORT=process.env.PORT||3000;
const ADMIN_PIN=process.env.ADMIN_PIN||"1234";

if(!process.env.DATABASE_URL){
  console.error("DATABASE_URL ausente");
  process.exit(1);
}

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:{rejectUnauthorized:false}
});

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const adminTokens=new Set();

const officialCatalog=[
  ["Pratos","Arroz + Vinagrete + Farofa + 1 Espeto","Prato com arroz, vinagrete, farofa e 1 espeto.",22.00,"🍛"],
  ["Pratos","Arroz + Vinagrete + Farofa + 2 Espetos","Prato com arroz, vinagrete, farofa e 2 espetos.",32.00,"🍛"],

  ["Espetos","Carne","Espeto de carne.",12.00,"🥩"],
  ["Espetos","Linguiça","Espeto de linguiça.",10.00,"🌭"],
  ["Espetos","Coração","Espeto de coração.",10.00,"🍢"],
  ["Espetos","Queijo","Espeto de queijo.",10.00,"🧀"],
  ["Espetos","Pão de Alho","Pão de alho.",10.00,"🥖"],

  ["Porções","Fritas com Bacon","Porção de batata frita com bacon.",25.00,"🍟"],
  ["Porções","Calabresa Acebolada","Porção de calabresa acebolada.",28.00,"🌭"],
  ["Porções","Mandioca Frita","Porção de mandioca frita.",25.00,"🍟"],

  ["Petiscos","Batata Lays","Batata Lays.",15.00,"🥔"],
  ["Petiscos","Amendoim","Porção de amendoim.",6.00,"🥜"],
  ["Petiscos","Ovinho de Amendoim","Ovinho de amendoim.",10.00,"🥜"],
  ["Petiscos","Torcida","Salgadinho Torcida.",5.00,"🥨"],

  ["Drinks","Caipirinha de Pinga","Caipirinha de pinga.",15.00,"🍸"],
  ["Drinks","Caipirinha de Vodca","Caipirinha de vodca.",20.00,"🍸"],
  ["Drinks","Drink de Aperol","Laranja, prosecco e água com gás.",30.00,"🍹"],
  ["Drinks","Gin Tônica","Laranja, limão siciliano e morango.",35.00,"🍸"],
  ["Drinks","Drink dos Gigantes","Cointreau, sal e limão.",25.00,"🍹"],

  ["Bebidas sem Álcool","Água","Água mineral.",3.00,"💧"],
  ["Bebidas sem Álcool","Água com Gás","Água com gás.",5.00,"💧"],
  ["Bebidas sem Álcool","Água de Coco","Água de coco.",8.00,"🥥"],
  ["Bebidas sem Álcool","Gatorade","Gatorade.",10.00,"🥤"],
  ["Bebidas sem Álcool","Suco Yakult","Suco Yakult.",8.00,"🧃"],
  ["Bebidas sem Álcool","Suco Del Valle","Suco Del Valle.",8.00,"🧃"],
  ["Bebidas sem Álcool","Refrigerante Lata","Refrigerante em lata.",8.00,"🥤"],
  ["Bebidas sem Álcool","H2O","H2O.",8.00,"🥤"],

  ["Bebidas Alcoólicas","Brahma Lata","Brahma em lata.",5.00,"🍺"],
  ["Bebidas Alcoólicas","Stella Artois","Stella Artois.",10.00,"🍺"],
  ["Bebidas Alcoólicas","Eisenbahn","Eisenbahn.",10.00,"🍺"],
  ["Bebidas Alcoólicas","Heineken","Heineken.",12.00,"🍺"],
  ["Bebidas Alcoólicas","Chopp 400 ml","Chopp 400 ml.",12.00,"🍺"],

  ["Suplementos e Snacks","Whey Protein","Whey Protein.",5.00,"💪"],
  ["Suplementos e Snacks","Joy Whey","Joy Whey.",5.00,"💪"],
  ["Suplementos e Snacks","Beats","Beats.",5.00,"🥤"],
  ["Suplementos e Snacks","Kit Kat","Kit Kat.",4.50,"🍫"],
  ["Suplementos e Snacks","Guaraviton","Guaraviton.",6.00,"🧃"],
  ["Suplementos e Snacks","Trident Sabor Canela","Trident sabor canela.",2.50,"🍬"]
];

async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings(
      id int primary key,
      name text not null,
      welcome text not null
    );

    CREATE TABLE IF NOT EXISTS categories(
      id serial primary key,
      name text unique not null
    );

    CREATE TABLE IF NOT EXISTS products(
      id serial primary key,
      name text not null,
      description text default '',
      price numeric(10,2) not null,
      category_id int references categories(id),
      emoji text default '🍔',
      image text default '',
      active boolean default true
    );

    CREATE TABLE IF NOT EXISTS tables_restaurant(
      id serial primary key,
      number int unique not null
    );

    CREATE TABLE IF NOT EXISTS orders(
      id serial primary key,
      table_number int not null,
      status text default 'Recebido',
      observation text default '',
      total numeric(10,2) not null,
      created_at timestamptz default now()
    );

    CREATE TABLE IF NOT EXISTS order_items(
      id serial primary key,
      order_id int references orders(id) on delete cascade,
      product_id int references products(id),
      product_name text not null,
      quantity int not null,
      unit_price numeric(10,2) not null
    );

    CREATE TABLE IF NOT EXISTS app_meta(
      key text primary key,
      value text not null
    );
  `);

  await pool.query(`
    INSERT INTO settings(id,name,welcome)
    VALUES(1,'Cantinho dos Gigantes','Bem-vindo! Faça seu pedido pelo celular.')
    ON CONFLICT(id) DO NOTHING
  `);

  for(let i=1;i<=12;i++){
    await pool.query(
      "insert into tables_restaurant(number) values($1) on conflict do nothing",
      [i]
    );
  }

  const version=(await pool.query(
    "select value from app_meta where key='official_catalog_version'"
  )).rows[0]?.value;

  if(version!=="1"){
    await pool.query("update products set active=false");

    const categories=[...new Set(officialCatalog.map(x=>x[0]))];
    const catMap={};

    for(const name of categories){
      const r=await pool.query(
        `insert into categories(name) values($1)
         on conflict(name) do update set name=excluded.name
         returning id`,
        [name]
      );
      catMap[name]=r.rows[0].id;
    }

    for(const [category,name,description,price,emoji] of officialCatalog){
      const existing=await pool.query(
        "select id from products where lower(name)=lower($1) order by id desc limit 1",
        [name]
      );

      if(existing.rowCount){
        await pool.query(
          `update products
           set description=$1,price=$2,category_id=$3,emoji=$4,active=true
           where id=$5`,
          [description,price,catMap[category],emoji,existing.rows[0].id]
        );
      }else{
        await pool.query(
          `insert into products(name,description,price,category_id,emoji,active)
           values($1,$2,$3,$4,$5,true)`,
          [name,description,price,catMap[category],emoji]
        );
      }
    }

    await pool.query(
      `insert into app_meta(key,value) values('official_catalog_version','1')
       on conflict(key) do update set value=excluded.value`
    );
  }
}

function requireAdmin(req,res,next){
  const token=req.headers["x-admin-token"];
  if(!token||!adminTokens.has(token)){
    return res.status(401).json({error:"Acesso administrativo não autorizado."});
  }
  next();
}

app.post("/api/admin/login",(req,res)=>{
  if(String(req.body.pin||"")!==ADMIN_PIN){
    return res.status(401).json({error:"Senha incorreta."});
  }
  const token=crypto.randomBytes(24).toString("hex");
  adminTokens.add(token);
  res.json({ok:true,token});
});

app.get("/api/menu",async(req,res)=>{
  try{
    const settings=(await pool.query(
      "select name,welcome from settings where id=1"
    )).rows[0];

    const categories=(await pool.query(`
      select c.id,c.name
      from categories c
      where exists(
        select 1 from products p
        where p.category_id=c.id and p.active=true
      )
      order by c.id
    `)).rows;

    const products=(await pool.query(`
      select p.*,c.name category
      from products p
      join categories c on c.id=p.category_id
      where p.active=true
      order by c.id,p.id
    `)).rows;

    res.json({settings,categories,products});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar cardápio."});
  }
});

app.post("/api/orders",async(req,res)=>{
  const {table,items,observation=""}=req.body;
  if(!Number(table)||!Array.isArray(items)||!items.length){
    return res.status(400).json({error:"Pedido inválido."});
  }

  const c=await pool.connect();
  try{
    await c.query("begin");
    let total=0,normalized=[];

    for(const item of items){
      const quantity=Math.max(1,Math.floor(Number(item.quantity)));
      const r=await c.query(
        "select id,name,price from products where id=$1 and active=true",
        [Number(item.product_id)]
      );
      if(!r.rowCount) throw Error("Produto inválido");

      const p=r.rows[0],price=Number(p.price);
      total+=price*quantity;
      normalized.push({p,quantity,price});
    }

    const order=(await c.query(
      `insert into orders(table_number,status,observation,total)
       values($1,'Recebido',$2,$3)
       returning id`,
      [Number(table),String(observation||""),total]
    )).rows[0];

    for(const x of normalized){
      await c.query(
        `insert into order_items
         (order_id,product_id,product_name,quantity,unit_price)
         values($1,$2,$3,$4,$5)`,
        [order.id,x.p.id,x.p.name,x.quantity,x.price]
      );
    }

    await c.query("commit");
    res.json({ok:true,id:order.id,total});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(400).json({error:"Não foi possível criar o pedido."});
  }finally{
    c.release();
  }
});

app.get("/api/admin/products",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query(`
      select p.*,c.name category
      from products p
      join categories c on c.id=p.category_id
      where p.active=true
      order by c.id,p.id
    `);
    res.json(r.rows);
  }catch(e){
    res.status(500).json({error:"Erro ao carregar produtos."});
  }
});

app.get("/api/admin/categories",requireAdmin,async(req,res)=>{
  try{
    res.json((await pool.query(
      "select id,name from categories order by id"
    )).rows);
  }catch(e){
    res.status(500).json({error:"Erro ao carregar categorias."});
  }
});

app.get("/api/orders",requireAdmin,async(req,res)=>{
  try{
    const orders=(await pool.query(
      "select * from orders order by id desc"
    )).rows;

    for(const o of orders){
      o.items=(await pool.query(
        `select product_name name,quantity,unit_price
         from order_items where order_id=$1 order by id`,
        [o.id]
      )).rows;
    }
    res.json(orders);
  }catch(e){
    res.status(500).json({error:"Erro ao carregar pedidos."});
  }
});

app.patch("/api/orders/:id",requireAdmin,async(req,res)=>{
  const allowed=["Recebido","Em preparo","Pronto","Entregue","Cancelado"];
  if(!allowed.includes(req.body.status)){
    return res.status(400).json({error:"Status inválido."});
  }
  try{
    await pool.query(
      "update orders set status=$1 where id=$2",
      [req.body.status,Number(req.params.id)]
    );
    res.json({ok:true});
  }catch(e){
    res.status(500).json({error:"Erro ao atualizar status."});
  }
});

app.post("/api/products",requireAdmin,async(req,res)=>{
  const x=req.body;
  if(!x.name||!Number(x.price)||!Number(x.category_id)){
    return res.status(400).json({error:"Preencha nome, preço e categoria."});
  }

  try{
    const r=await pool.query(
      `insert into products
       (name,description,price,category_id,emoji,image,active)
       values($1,$2,$3,$4,$5,$6,true)
       returning id`,
      [
        String(x.name),
        String(x.description||""),
        Number(x.price),
        Number(x.category_id),
        String(x.emoji||"🍽️"),
        String(x.image||"")
      ]
    );
    res.json(r.rows[0]);
  }catch(e){
    res.status(500).json({error:"Erro ao cadastrar produto."});
  }
});

app.put("/api/products/:id",requireAdmin,async(req,res)=>{
  const x=req.body;
  try{
    await pool.query(
      `update products
       set name=$1,description=$2,price=$3,category_id=$4,emoji=$5,image=$6
       where id=$7`,
      [
        String(x.name),
        String(x.description||""),
        Number(x.price),
        Number(x.category_id),
        String(x.emoji||"🍽️"),
        String(x.image||""),
        Number(req.params.id)
      ]
    );
    res.json({ok:true});
  }catch(e){
    res.status(500).json({error:"Erro ao atualizar produto."});
  }
});

app.delete("/api/products/:id",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query(
      "update products set active=false where id=$1 returning id,name",
      [Number(req.params.id)]
    );
    if(!r.rowCount){
      return res.status(404).json({error:"Produto não encontrado."});
    }
    res.json({ok:true});
  }catch(e){
    res.status(500).json({error:"Erro ao excluir produto."});
  }
});

app.post("/api/categories",requireAdmin,async(req,res)=>{
  const name=String(req.body.name||"").trim();
  if(!name)return res.status(400).json({error:"Nome obrigatório."});
  try{
    const r=await pool.query(
      `insert into categories(name) values($1)
       on conflict(name) do update set name=excluded.name
       returning id,name`,
      [name]
    );
    res.json(r.rows[0]);
  }catch(e){
    res.status(500).json({error:"Erro ao criar categoria."});
  }
});

app.put("/api/settings",requireAdmin,async(req,res)=>{
  try{
    await pool.query(
      "update settings set name=$1,welcome=$2 where id=1",
      [String(req.body.name||"Cantinho dos Gigantes"),String(req.body.welcome||"")]
    );
    res.json({ok:true});
  }catch(e){
    res.status(500).json({error:"Erro ao salvar configurações."});
  }
});

app.get("/api/qrcode/:table",requireAdmin,async(req,res)=>{
  try{
    const url=`${req.protocol}://${req.get("host")}/?mesa=${encodeURIComponent(req.params.table)}`;
    const png=await QRCode.toDataURL(url,{width:700,margin:2});
    res.json({url,png});
  }catch(e){
    res.status(500).json({error:"Erro ao gerar QR Code."});
  }
});

app.get("/api/stats",requireAdmin,async(req,res)=>{
  try{
    const o=(await pool.query(
      "select count(*)::int c,coalesce(sum(total),0) total from orders where status<>'Cancelado'"
    )).rows[0];
    const p=(await pool.query(
      "select count(*)::int c from products where active=true"
    )).rows[0].c;
    const t=(await pool.query(
      "select count(*)::int c from tables_restaurant"
    )).rows[0].c;
    res.json({
      orders:o.c,
      total:Number(o.total),
      products:p,
      tables:t
    });
  }catch(e){
    res.status(500).json({error:"Erro ao carregar estatísticas."});
  }
});

app.get("/health",async(req,res)=>{
  try{
    await pool.query("select 1");
    res.json({ok:true,database:"connected"});
  }catch(e){
    res.status(500).json({ok:false,database:"error"});
  }
});

init()
  .then(()=>app.listen(PORT,()=>console.log("Cantinho dos Gigantes rodando na porta "+PORT)))
  .catch(e=>{
    console.error("Erro na inicialização:",e);
    process.exit(1);
  });
