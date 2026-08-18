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

const ADMIN_SESSION_HOURS=12;

function createAdminToken(){
  const payload={
    role:"admin",
    exp:Date.now()+(ADMIN_SESSION_HOURS*60*60*1000)
  };
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig=crypto.createHmac("sha256",ADMIN_PIN).update(body).digest("base64url");
  return body+"."+sig;
}

function verifyAdminToken(token){
  try{
    if(!token||typeof token!=="string")return false;
    const [body,sig]=token.split(".");
    if(!body||!sig)return false;

    const expected=crypto.createHmac("sha256",ADMIN_PIN).update(body).digest("base64url");
    const a=Buffer.from(sig);
    const b=Buffer.from(expected);

    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;

    const payload=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
    return payload.role==="admin" && Number(payload.exp)>Date.now();
  }catch(e){
    return false;
  }
}

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
      emoji text default '🍽️',
      image text default '',
      active boolean default true
    );

    CREATE TABLE IF NOT EXISTS tables_restaurant(
      id serial primary key,
      number int unique not null
    );

    CREATE TABLE IF NOT EXISTS table_accounts(
      id serial primary key,
      table_number int not null,
      status text not null default 'Aberta',
      payment_method text,
      opened_at timestamptz not null default now(),
      closed_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS orders(
      id serial primary key,
      table_number int not null,
      status text default 'Recebido',
      observation text default '',
      total numeric(10,2) not null,
      created_at timestamptz default now()
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS account_id int REFERENCES table_accounts(id);

    CREATE TABLE IF NOT EXISTS order_items(
      id serial primary key,
      order_id int references orders(id) on delete cascade,
      product_id int references products(id),
      product_name text not null,
      quantity int not null,
      unit_price numeric(10,2) not null
    );

    CREATE TABLE IF NOT EXISTS cash_sessions(
      id serial primary key,
      status text not null default 'Aberto',
      opening_amount numeric(10,2) not null default 0,
      opened_at timestamptz not null default now(),
      closed_at timestamptz,
      closing_amount numeric(10,2),
      expected_amount numeric(10,2),
      notes text default ''
    );

    CREATE INDEX IF NOT EXISTS idx_orders_account_id ON orders(account_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_table_status ON table_accounts(table_number,status);
    CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status);
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
}

function requireAdmin(req,res,next){
  const token=req.headers["x-admin-token"];
  if(!verifyAdminToken(token)){
    return res.status(401).json({
      error:"Sessão administrativa expirada. Entre novamente."
    });
  }
  next();
}

async function getOrCreateOpenAccount(client,tableNumber){
  let r=await client.query(
    `select * from table_accounts
     where table_number=$1 and status='Aberta'
     order by id desc limit 1
     for update`,
    [tableNumber]
  );
  if(r.rowCount)return r.rows[0];

  r=await client.query(
    `insert into table_accounts(table_number,status)
     values($1,'Aberta')
     returning *`,
    [tableNumber]
  );
  return r.rows[0];
}

app.post("/api/admin/login",(req,res)=>{
  if(String(req.body.pin||"")!==ADMIN_PIN){
    return res.status(401).json({error:"Senha incorreta."});
  }
  const token=createAdminToken();
  res.json({ok:true,token,expires_in_hours:ADMIN_SESSION_HOURS});
});

app.get("/api/menu",async(req,res)=>{
  try{
    const settings=(await pool.query("select name,welcome from settings where id=1")).rows[0];
    const categories=(await pool.query(`
      select c.id,c.name
      from categories c
      where exists(select 1 from products p where p.category_id=c.id and p.active=true)
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
  const tableNumber=Number(table);

  if(!Number.isInteger(tableNumber)||tableNumber<1||!Array.isArray(items)||!items.length){
    return res.status(400).json({error:"Pedido inválido."});
  }

  const c=await pool.connect();
  try{
    await c.query("begin");
    const account=await getOrCreateOpenAccount(c,tableNumber);

    let total=0;
    const normalized=[];

    for(const item of items){
      const quantity=Math.max(1,Math.floor(Number(item.quantity)));
      const r=await c.query(
        "select id,name,price from products where id=$1 and active=true",
        [Number(item.product_id)]
      );
      if(!r.rowCount)throw Error("Produto inválido");
      const p=r.rows[0], price=Number(p.price);
      total+=price*quantity;
      normalized.push({p,quantity,price});
    }

    const order=(await c.query(
      `insert into orders(account_id,table_number,status,observation,total)
       values($1,$2,'Recebido',$3,$4)
       returning id`,
      [account.id,tableNumber,String(observation||""),total]
    )).rows[0];

    for(const x of normalized){
      await c.query(
        `insert into order_items(order_id,product_id,product_name,quantity,unit_price)
         values($1,$2,$3,$4,$5)`,
        [order.id,x.p.id,x.p.name,x.quantity,x.price]
      );
    }

    await c.query("commit");
    res.json({ok:true,id:order.id,account_id:account.id,total});
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
    res.json((await pool.query(`
      select p.*,c.name category
      from products p join categories c on c.id=p.category_id
      where p.active=true order by c.id,p.id
    `)).rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar produtos."})}
});

app.get("/api/admin/categories",requireAdmin,async(req,res)=>{
  try{
    res.json((await pool.query("select id,name from categories order by id")).rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar categorias."})}
});

app.get("/api/orders",requireAdmin,async(req,res)=>{
  try{
    const orders=(await pool.query("select * from orders order by id desc")).rows;
    for(const o of orders){
      o.items=(await pool.query(
        `select product_name name,quantity,unit_price
         from order_items where order_id=$1 order by id`,
        [o.id]
      )).rows;
    }
    res.json(orders);
  }catch(e){res.status(500).json({error:"Erro ao carregar pedidos."})}
});

app.patch("/api/orders/:id",requireAdmin,async(req,res)=>{
  const allowed=["Recebido","Em preparo","Pronto","Entregue","Cancelado"];
  if(!allowed.includes(req.body.status)){
    return res.status(400).json({error:"Status inválido."});
  }
  try{
    await pool.query("update orders set status=$1 where id=$2",[req.body.status,Number(req.params.id)]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Erro ao atualizar status."})}
});

app.get("/api/accounts",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`
      select
        a.id,a.table_number,a.status,a.payment_method,a.opened_at,a.closed_at,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
        count(o.id) filter(where o.status<>'Cancelado')::int order_count
      from table_accounts a
      left join orders o on o.account_id=a.id
      group by a.id
      order by
        case when a.status='Aberta' then 0 else 1 end,
        a.table_number,
        a.id desc
    `)).rows;
    res.json(rows);
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar comandas."});
  }
});

app.get("/api/accounts/table/:table",requireAdmin,async(req,res)=>{
  try{
    const tableNumber=Number(req.params.table);
    const account=(await pool.query(`
      select * from table_accounts
      where table_number=$1 and status='Aberta'
      order by id desc limit 1
    `,[tableNumber])).rows[0];

    if(!account)return res.json({open:false,table_number:tableNumber,orders:[],total:0});

    const orders=(await pool.query(`
      select * from orders
      where account_id=$1
      order by id
    `,[account.id])).rows;

    let total=0;
    for(const o of orders){
      o.items=(await pool.query(
        `select product_name name,quantity,unit_price
         from order_items where order_id=$1 order by id`,
        [o.id]
      )).rows;
      if(o.status!=="Cancelado")total+=Number(o.total);
    }

    res.json({open:true,account,orders,total});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar comanda."});
  }
});

app.post("/api/accounts/:id/close",requireAdmin,async(req,res)=>{
  const allowed=["PIX","Dinheiro","Cartão"];
  const payment=String(req.body.payment_method||"");
  if(!allowed.includes(payment)){
    return res.status(400).json({error:"Forma de pagamento inválida."});
  }

  const c=await pool.connect();
  try{
    await c.query("begin");

    const account=(await c.query(
      `select * from table_accounts
       where id=$1 and status='Aberta'
       for update`,
      [Number(req.params.id)]
    )).rows[0];

    if(!account){
      await c.query("rollback");
      return res.status(404).json({error:"Comanda aberta não encontrada."});
    }

    const total=Number((await c.query(`
      select coalesce(sum(total),0)::numeric total
      from orders
      where account_id=$1 and status<>'Cancelado'
    `,[account.id])).rows[0].total);

    await c.query(`
      update table_accounts
      set status='Fechada',payment_method=$1,closed_at=now()
      where id=$2
    `,[payment,account.id]);

    await c.query("commit");
    res.json({ok:true,total,payment_method:payment,table_number:account.table_number});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(500).json({error:"Erro ao fechar a conta."});
  }finally{
    c.release();
  }
});

app.post("/api/products",requireAdmin,async(req,res)=>{
  const x=req.body;
  if(!x.name||!Number(x.price)||!Number(x.category_id)){
    return res.status(400).json({error:"Preencha nome, preço e categoria."});
  }
  try{
    const r=await pool.query(
      `insert into products(name,description,price,category_id,emoji,image,active)
       values($1,$2,$3,$4,$5,$6,true) returning id`,
      [String(x.name),String(x.description||""),Number(x.price),Number(x.category_id),
       String(x.emoji||"🍽️"),String(x.image||"")]
    );
    res.json(r.rows[0]);
  }catch(e){res.status(500).json({error:"Erro ao cadastrar produto."})}
});

app.put("/api/products/:id",requireAdmin,async(req,res)=>{
  const x=req.body;
  try{
    await pool.query(
      `update products set name=$1,description=$2,price=$3,category_id=$4,emoji=$5,image=$6 where id=$7`,
      [String(x.name),String(x.description||""),Number(x.price),Number(x.category_id),
       String(x.emoji||"🍽️"),String(x.image||""),Number(req.params.id)]
    );
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Erro ao atualizar produto."})}
});

app.delete("/api/products/:id",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query(
      "update products set active=false where id=$1 returning id,name",
      [Number(req.params.id)]
    );
    if(!r.rowCount)return res.status(404).json({error:"Produto não encontrado."});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Erro ao excluir produto."})}
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
  }catch(e){res.status(500).json({error:"Erro ao criar categoria."})}
});

app.put("/api/settings",requireAdmin,async(req,res)=>{
  try{
    await pool.query(
      "update settings set name=$1,welcome=$2 where id=1",
      [String(req.body.name||"Cantinho dos Gigantes"),String(req.body.welcome||"")]
    );
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Erro ao salvar configurações."})}
});

app.get("/api/qrcode/:table",requireAdmin,async(req,res)=>{
  try{
    const url=`${req.protocol}://${req.get("host")}/?mesa=${encodeURIComponent(req.params.table)}`;
    const png=await QRCode.toDataURL(url,{width:700,margin:2});
    res.json({url,png});
  }catch(e){res.status(500).json({error:"Erro ao gerar QR Code."})}
});


// CAIXA E HISTÓRICO DE VENDAS
app.get("/api/sales/history",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`
      select a.id,a.table_number,a.payment_method,a.opened_at,a.closed_at,
             coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
             count(o.id) filter(where o.status<>'Cancelado')::int order_count
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Fechada'
      group by a.id
      order by a.closed_at desc nulls last,a.id desc
      limit 300
    `)).rows;
    res.json(rows);
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar histórico de vendas."});
  }
});

app.get("/api/cash",requireAdmin,async(req,res)=>{
  try{
    const session=(await pool.query(`
      select * from cash_sessions where status='Aberto' order by id desc limit 1
    `)).rows[0]||null;

    let summary={pix:0,dinheiro:0,cartao:0,sales_total:0,count:0};
    if(session){
      const r=(await pool.query(`
        select
          coalesce(sum(x.total) filter(where x.payment_method='PIX'),0)::numeric pix,
          coalesce(sum(x.total) filter(where x.payment_method='Dinheiro'),0)::numeric dinheiro,
          coalesce(sum(x.total) filter(where x.payment_method='Cartão'),0)::numeric cartao,
          coalesce(sum(x.total),0)::numeric sales_total,
          count(*)::int count
        from (
          select a.id,a.payment_method,coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
          from table_accounts a
          left join orders o on o.account_id=a.id
          where a.status='Fechada' and a.closed_at>= $1
          group by a.id
        ) x
      `,[session.opened_at])).rows[0];
      summary={pix:Number(r.pix),dinheiro:Number(r.dinheiro),cartao:Number(r.cartao),sales_total:Number(r.sales_total),count:r.count};
    }
    res.json({session,summary});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar caixa."});
  }
});

app.post("/api/cash/open",requireAdmin,async(req,res)=>{
  const opening=Number(req.body.opening_amount||0);
  if(!Number.isFinite(opening)||opening<0)return res.status(400).json({error:"Valor inicial inválido."});
  try{
    const exists=(await pool.query("select id from cash_sessions where status='Aberto' limit 1")).rowCount;
    if(exists)return res.status(400).json({error:"Já existe um caixa aberto."});
    const row=(await pool.query(`
      insert into cash_sessions(opening_amount,status) values($1,'Aberto') returning *
    `,[opening])).rows[0];
    res.json({ok:true,session:row});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao abrir caixa."});
  }
});

app.post("/api/cash/:id/close",requireAdmin,async(req,res)=>{
  const closing=Number(req.body.closing_amount);
  if(!Number.isFinite(closing)||closing<0)return res.status(400).json({error:"Informe o valor contado no caixa."});
  const c=await pool.connect();
  try{
    await c.query("begin");
    const session=(await c.query(`select * from cash_sessions where id=$1 and status='Aberto' for update`,[Number(req.params.id)])).rows[0];
    if(!session){await c.query("rollback");return res.status(404).json({error:"Caixa aberto não encontrado."});}
    const r=(await c.query(`
      select coalesce(sum(x.total),0)::numeric total
      from (
        select a.id,coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
        from table_accounts a left join orders o on o.account_id=a.id
        where a.status='Fechada' and a.closed_at>= $1 and a.payment_method='Dinheiro'
        group by a.id
      ) x
    `,[session.opened_at])).rows[0];
    const expected=Number(session.opening_amount)+Number(r.total);
    const row=(await c.query(`
      update cash_sessions set status='Fechado',closed_at=now(),closing_amount=$1,expected_amount=$2,notes=$3
      where id=$4 returning *
    `,[closing,expected,String(req.body.notes||""),session.id])).rows[0];
    await c.query("commit");
    res.json({ok:true,session:row,difference:closing-expected});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(500).json({error:"Erro ao fechar caixa."});
  }finally{c.release()}
});

app.get("/api/cash/history",requireAdmin,async(req,res)=>{
  try{
    res.json((await pool.query("select * from cash_sessions order by id desc limit 100")).rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar histórico do caixa."})}
});

app.get("/api/stats",requireAdmin,async(req,res)=>{
  try{
    const orders=(await pool.query("select count(*)::int c from orders")).rows[0].c;
    const open=(await pool.query(`
      select count(*)::int c,
             coalesce(sum(x.total),0)::numeric total
      from (
        select a.id,coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0) total
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Aberta'
        group by a.id
      ) x
    `)).rows[0];
    const paid=Number((await pool.query(`
      select coalesce(sum(x.total),0)::numeric total
      from (
        select a.id,coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0) total
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Fechada'
        group by a.id
      ) x
    `)).rows[0].total);
    const products=(await pool.query("select count(*)::int c from products where active=true")).rows[0].c;

    res.json({
      orders,
      open_tables:open.c,
      open_total:Number(open.total),
      paid_total:paid,
      products
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar estatísticas."});
  }
});



app.get("/api/reports/period",requireAdmin,async(req,res)=>{
  try{
    const start=String(req.query.start||"").trim();
    const end=String(req.query.end||"").trim();

    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)){
      return res.status(400).json({error:"Período inválido."});
    }

    const summary=(await pool.query(`
      select
        coalesce(sum(case when payment_method='PIX' then total else 0 end),0)::numeric pix,
        coalesce(sum(case when payment_method='Dinheiro' then total else 0 end),0)::numeric dinheiro,
        coalesce(sum(case when payment_method='Cartão' then total else 0 end),0)::numeric cartao,
        coalesce(sum(total),0)::numeric total,
        count(*)::int contas
      from (
        select a.id,a.payment_method,
          coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Fechada'
          and (a.closed_at at time zone 'America/Sao_Paulo')::date between $1::date and $2::date
        group by a.id,a.payment_method
      ) x
    `,[start,end])).rows[0];

    const products=(await pool.query(`
      select oi.product_name name,
        sum(oi.quantity)::int quantity,
        sum(oi.quantity*oi.unit_price)::numeric total
      from order_items oi
      join orders o on o.id=oi.order_id
      join table_accounts a on a.id=o.account_id
      where a.status='Fechada'
        and o.status<>'Cancelado'
        and (a.closed_at at time zone 'America/Sao_Paulo')::date between $1::date and $2::date
      group by oi.product_name
      order by quantity desc,total desc
      limit 100
    `,[start,end])).rows;

    const days=(await pool.query(`
      select
        (a.closed_at at time zone 'America/Sao_Paulo')::date day,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
        count(distinct a.id)::int contas
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Fechada'
        and (a.closed_at at time zone 'America/Sao_Paulo')::date between $1::date and $2::date
      group by day
      order by day
    `,[start,end])).rows;

    const total=Number(summary.total);
    const contas=Number(summary.contas);
    const items=products.reduce((n,p)=>n+Number(p.quantity),0);

    res.json({
      start,end,
      summary:{
        total,
        pix:Number(summary.pix),
        dinheiro:Number(summary.dinheiro),
        cartao:Number(summary.cartao),
        contas,
        ticket_medio:contas?total/contas:0,
        itens:items
      },
      products:products.map(x=>({...x,total:Number(x.total)})),
      days:days.map(x=>({...x,total:Number(x.total)}))
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao gerar relatório por período."});
  }
});

app.get("/api/reports/daily",requireAdmin,async(req,res)=>{
  try{
    const date=String(req.query.date||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
      return res.status(400).json({error:"Data inválida."});
    }

    const summary=(await pool.query(`
      select
        coalesce(sum(case when payment_method='PIX' then total else 0 end),0)::numeric pix,
        coalesce(sum(case when payment_method='Dinheiro' then total else 0 end),0)::numeric dinheiro,
        coalesce(sum(case when payment_method='Cartão' then total else 0 end),0)::numeric cartao,
        coalesce(sum(total),0)::numeric total,
        count(*)::int contas
      from (
        select a.id,a.payment_method,
          coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Fechada'
          and (a.closed_at at time zone 'America/Sao_Paulo')::date=$1::date
        group by a.id,a.payment_method
      ) x
    `,[date])).rows[0];

    const accounts=(await pool.query(`
      select a.id,a.table_number,a.payment_method,a.closed_at,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
        count(o.id) filter(where o.status<>'Cancelado')::int order_count
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Fechada'
        and (a.closed_at at time zone 'America/Sao_Paulo')::date=$1::date
      group by a.id
      order by a.closed_at desc
    `,[date])).rows;

    const products=(await pool.query(`
      select oi.product_name name,
        sum(oi.quantity)::int quantity,
        sum(oi.quantity*oi.unit_price)::numeric total
      from order_items oi
      join orders o on o.id=oi.order_id
      join table_accounts a on a.id=o.account_id
      where a.status='Fechada'
        and o.status<>'Cancelado'
        and (a.closed_at at time zone 'America/Sao_Paulo')::date=$1::date
      group by oi.product_name
      order by quantity desc,total desc
      limit 50
    `,[date])).rows;

    const cash=(await pool.query(`
      select * from cash_sessions
      where status='Fechado'
        and (closed_at at time zone 'America/Sao_Paulo')::date=$1::date
      order by closed_at desc
    `,[date])).rows;

    res.json({
      date,
      summary:{
        total:Number(summary.total),
        pix:Number(summary.pix),
        dinheiro:Number(summary.dinheiro),
        cartao:Number(summary.cartao),
        contas:summary.contas
      },
      accounts:accounts.map(x=>({...x,total:Number(x.total)})),
      products:products.map(x=>({...x,total:Number(x.total)})),
      cash
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao gerar relatório diário."});
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
