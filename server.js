const express=require("express");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");
const QRCode=require("qrcode");

const app=express();
const PORT=process.env.PORT||3000;
const ADMIN_PIN=String(process.env.ADMIN_PIN||"").trim();
const MP_ACCESS_TOKEN=String(process.env.MP_ACCESS_TOKEN||"").trim();
const TABLE_QR_SECRET=String(process.env.TABLE_QR_SECRET||"").trim();

if(!ADMIN_PIN){
  console.error("ADMIN_PIN ausente. Configure a variável no Render antes de iniciar o sistema.");
  process.exit(1);
}
if(!TABLE_QR_SECRET){
  console.error("TABLE_QR_SECRET ausente. Configure a variável no Render antes de iniciar o sistema.");
  process.exit(1);
}

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

    ALTER TABLE table_accounts ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'Mesa';
    ALTER TABLE table_accounts ADD COLUMN IF NOT EXISTS customer_name text DEFAULT '';

    CREATE TABLE IF NOT EXISTS orders(
      id serial primary key,
      table_number int not null,
      status text default 'Recebido',
      observation text default '',
      total numeric(10,2) not null,
      created_at timestamptz default now()
    );

    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity int NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_control boolean NOT NULL DEFAULT false;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_low_threshold int NOT NULL DEFAULT 5;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price numeric(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_type text NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_grape text NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_origin text NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_vintage text NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS wine_volume_ml int;

    CREATE TABLE IF NOT EXISTS stock_movements(
      id serial primary key,
      product_id int references products(id),
      movement_type text not null,
      quantity int not null,
      previous_quantity int not null,
      new_quantity int not null,
      note text default '',
      created_at timestamptz not null default now()
    );

    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS previous_cost numeric(10,2);
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS new_cost numeric(10,2);
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS entry_unit_cost numeric(10,2);

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS account_id int REFERENCES table_accounts(id);

    CREATE TABLE IF NOT EXISTS order_items(
      id serial primary key,
      order_id int references orders(id) on delete cascade,
      product_id int references products(id),
      product_name text not null,
      quantity int not null,
      unit_price numeric(10,2) not null
    );

    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost numeric(10,2);

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
    CREATE TABLE IF NOT EXISTS pix_payments(
      id serial primary key,
      account_id int references table_accounts(id),
      table_number int not null,
      mp_order_id text unique,
      external_reference text unique not null,
      amount numeric(10,2) not null,
      status text not null default 'pending',
      payer_email text not null,
      qr_code text default '',
      qr_code_base64 text default '',
      ticket_url text default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );


    CREATE TABLE IF NOT EXISTS profit_historical_rules(
      normalized_name text primary key,
      display_name text not null default '',
      alias_product_id int references products(id),
      historical_unit_cost numeric(10,2),
      ignored boolean not null default false,
      updated_at timestamptz not null default now()
    );

    CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_pix_account_id ON pix_payments(account_id);
    CREATE INDEX IF NOT EXISTS idx_pix_account_status ON pix_payments(account_id,status);
  `);

  await pool.query(`
    INSERT INTO settings(id,name,welcome)
    VALUES(1,'Cantinho dos Gigantes','Bem-vindo! Faça seu pedido pelo celular.')
    ON CONFLICT(id) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO categories(name) VALUES('Carta de Vinhos')
    ON CONFLICT(name) DO NOTHING
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

function tableAccessToken(tableNumber){
  return crypto.createHmac("sha256",TABLE_QR_SECRET).update(String(tableNumber)).digest("hex").slice(0,32);
}

function validTableAccess(tableNumber,token){
  const expected=tableAccessToken(tableNumber);
  const a=Buffer.from(String(token||""));
  const b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

async function mercadoPago(pathname,options={}){
  if(!MP_ACCESS_TOKEN)throw Error("PIX ainda não foi configurado no servidor.");
  const r=await fetch("https://api.mercadopago.com"+pathname,{
    ...options,
    headers:{
      "Accept":"application/json",
      "Content-Type":"application/json",
      "Authorization":"Bearer "+MP_ACCESS_TOKEN,
      ...(options.headers||{})
    }
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    console.error("Mercado Pago",r.status,JSON.stringify(data,null,2));
    throw Error(data.message||data.error||"Não foi possível gerar o Pix.");
  }
  return data;
}


async function reconcilePaidPixAccounts(){
  // Procura pagamentos PIX ligados a comandas que ainda constam como abertas.
  // O Mercado Pago é a fonte de verdade: só fecha a comanda se a order estiver realmente paga.
  const rows=(await pool.query(`
    select pp.id,pp.account_id,pp.table_number,pp.mp_order_id,pp.amount,pp.status
    from pix_payments pp
    join table_accounts a on a.id=pp.account_id
    where a.status='Aberta'
      and pp.mp_order_id is not null
    order by pp.id desc
    limit 30
  `)).rows;

  let closed=0;

  for(const p of rows){
    try{
      const data=await mercadoPago("/v1/orders/"+encodeURIComponent(p.mp_order_id));
      const payment=data?.transactions?.payments?.[0]||{};
      const rawStatus=String(payment.status||data.status||"").toLowerCase();
      const paid=["processed","approved","paid"].includes(rawStatus);

      if(!paid){
        await pool.query(
          `update pix_payments set status=$1,updated_at=now() where id=$2`,
          [rawStatus||"pending",p.id]
        );
        continue;
      }

      const c=await pool.connect();
      try{
        await c.query("begin");
        await c.query("select pg_advisory_xact_lock($1)",[FINANCE_LOCK_KEY]);

        const account=(await c.query(
          `select * from table_accounts where id=$1 for update`,
          [p.account_id]
        )).rows[0];

        await c.query(
          `update pix_payments set status='paid',updated_at=now() where id=$1`,
          [p.id]
        );

        if(account && account.status==='Aberta'){
          const cashSession=await getOpenCashSession(c);
          if(!cashSession){
            console.error("PIX confirmado sem caixa aberto; comanda mantida aberta para conferência.",{pix_id:p.id,account_id:p.account_id});
            await c.query("commit");
            continue;
          }

          // Confere o total da própria comanda vinculada ao PIX.
          const total=Number((await c.query(`
            select coalesce(sum(total),0)::numeric total
            from orders
            where account_id=$1 and status<>'Cancelado'
          `,[account.id])).rows[0].total);

          // Só fecha se o valor pago corresponde ao valor da comanda.
          if(Math.abs(total-Number(p.amount))<0.01){
            const updated=await c.query(`
              update table_accounts
              set status='Fechada',payment_method='PIX',closed_at=now()
              where id=$1 and status='Aberta'
              returning id
            `,[account.id]);

            // Incrementa somente quando esta chamada realmente mudou Aberta -> Fechada.
            if(updated.rowCount===1)closed++;
          }else{
            console.error(
              "PIX pago com valor diferente da comanda:",
              {pix_id:p.id,account_id:p.account_id,pago:Number(p.amount),comanda:total}
            );
          }
        }

        await c.query("commit");
      }catch(e){
        try{await c.query("rollback")}catch(_e){}
        throw e;
      }finally{
        c.release();
      }
    }catch(e){
      // Um PIX antigo/de teste inválido não deve impedir a reconciliação dos demais.
      console.error("Falha ao reconciliar PIX",p.id,e.message||e);
    }
  }

  return {checked:rows.length,closed};
}


const TABLE_ACCOUNT_MAX_OPEN_MS=18*60*60*1000;
function isStaleTableAccount(account){
  if(!account || account.account_type!=="Mesa" || !account.opened_at)return false;
  const opened=new Date(account.opened_at).getTime();
  return Number.isFinite(opened) && (Date.now()-opened)>TABLE_ACCOUNT_MAX_OPEN_MS;
}
function staleTableAccountMessage(){
  return "Esta mesa possui uma comanda antiga ainda aberta. Peça ao atendimento para fechar ou cancelar a comanda anterior antes de fazer um novo pedido.";
}

// Todas as operações que mudam o estado financeiro compartilham o mesmo lock.
// Isso evita corrida entre "fechar conta" e "fechar caixa".
const FINANCE_LOCK_KEY=734215621;

async function getOpenCashSession(db){
  return (await db.query(`
    select * from cash_sessions
    where status='Aberto'
    order by id desc limit 1
  `)).rows[0]||null;
}

async function getOpenAccountsSummary(db){
  const r=(await db.query(`
    select count(*)::int count,coalesce(sum(x.total),0)::numeric total
    from (
      select a.id,coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Aberta'
      group by a.id
      having coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)>0
    ) x
  `)).rows[0];
  return {count:Number(r.count||0),total:Number(r.total||0)};
}

function noOpenCashMessage(){
  return "Abra o caixa antes de receber ou fechar uma conta. Nenhum pagamento pode ser registrado com o caixa fechado.";
}

async function getOrCreateOpenAccount(client,tableNumber){
  // Serializa a criação da comanda por mesa para evitar duas comandas abertas
  // quando dois pedidos chegam praticamente ao mesmo tempo.
  await client.query("select pg_advisory_xact_lock($1)",[tableNumber]);

  const tableExists=await client.query(
    "select 1 from tables_restaurant where number=$1 limit 1",
    [tableNumber]
  );
  if(!tableExists.rowCount)throw Error("Mesa não cadastrada.");

  let r=await client.query(
    `select * from table_accounts
     where table_number=$1 and status='Aberta' and account_type='Mesa'
     order by id desc limit 1
     for update`,
    [tableNumber]
  );
  if(r.rowCount){
    const existing=r.rows[0];
    if(isStaleTableAccount(existing))throw Error(staleTableAccountMessage());
    return existing;
  }

  r=await client.query(
    `insert into table_accounts(table_number,status,account_type,customer_name)
     values($1,'Aberta','Mesa','')
     returning *`,
    [tableNumber]
  );
  return r.rows[0];
}

const adminLoginAttempts=new Map();
function adminLoginKey(req){
  return String(req.headers["x-forwarded-for"]||req.ip||"unknown").split(",")[0].trim();
}
function adminLoginBlocked(req){
  const key=adminLoginKey(req),now=Date.now();
  const state=adminLoginAttempts.get(key);
  if(!state)return {blocked:false,key};
  if(now-state.first>15*60*1000){adminLoginAttempts.delete(key);return {blocked:false,key};}
  return {blocked:state.count>=8,key,retry_ms:Math.max(0,15*60*1000-(now-state.first))};
}
function recordAdminLoginFailure(key){
  const now=Date.now(),state=adminLoginAttempts.get(key);
  if(!state||now-state.first>15*60*1000)adminLoginAttempts.set(key,{count:1,first:now});
  else {state.count++;adminLoginAttempts.set(key,state);}
}
function clearAdminLoginFailures(key){adminLoginAttempts.delete(key);}

app.post("/api/admin/login",(req,res)=>{
  const attempt=adminLoginBlocked(req);
  if(attempt.blocked){
    res.set("Retry-After",String(Math.ceil(attempt.retry_ms/1000)));
    return res.status(429).json({error:"Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente."});
  }
  const supplied=String(req.body.pin||"");
  const a=Buffer.from(supplied);
  const b=Buffer.from(String(ADMIN_PIN));
  const same=a.length===b.length && crypto.timingSafeEqual(a,b);
  if(!same){
    recordAdminLoginFailure(attempt.key);
    return res.status(401).json({error:"Senha incorreta."});
  }
  clearAdminLoginFailures(attempt.key);
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
  const accessToken=String(req.body.access_token||req.body.token||"");

  if(!Number.isInteger(tableNumber)||tableNumber<1||!Array.isArray(items)||!items.length){
    return res.status(400).json({error:"Pedido inválido."});
  }
  if(items.length>50){
    return res.status(400).json({error:"Há itens demais neste pedido."});
  }
  if(!validTableAccess(tableNumber,accessToken)){
    return res.status(403).json({error:"QR Code inválido ou expirado. Abra o cardápio pelo QR Code da mesa."});
  }

  const c=await pool.connect();
  try{
    await c.query("begin");
    const account=await getOrCreateOpenAccount(c,tableNumber);

    let total=0;
    const normalized=[];

    for(const item of items){
      const rawQuantity=Number(item.quantity);
      if(!Number.isFinite(rawQuantity)||rawQuantity<1||rawQuantity>99){
        throw Error("Quantidade inválida. Use de 1 a 99 unidades por item.");
      }
      const quantity=Math.floor(rawQuantity);
      const r=await c.query(
        "select id,name,price,cost_price,stock_quantity,stock_control from products where id=$1 and active=true for update",
        [Number(item.product_id)]
      );
      if(!r.rowCount)throw Error("Produto inválido");
      const p=r.rows[0], price=Number(p.price), cost=Number(p.cost_price||0);
      if(p.stock_control && Number(p.stock_quantity)<quantity){
        throw Error(`Estoque insuficiente para ${p.name}. Disponível: ${p.stock_quantity}`);
      }
      total+=price*quantity;
      normalized.push({p,quantity,price,cost});
    }

    const order=(await c.query(
      `insert into orders(account_id,table_number,status,observation,total)
       values($1,$2,'Recebido',$3,$4)
       returning id`,
      [account.id,tableNumber,String(observation||""),total]
    )).rows[0];

    for(const x of normalized){
      await c.query(
        `insert into order_items(order_id,product_id,product_name,quantity,unit_price,unit_cost)
         values($1,$2,$3,$4,$5,$6)`,
        [order.id,x.p.id,x.p.name,x.quantity,x.price,x.cost]
      );
      if(x.p.stock_control){
        const previous=Number(x.p.stock_quantity||0);
        const next=previous-x.quantity;
        await c.query(
          "update products set stock_quantity=$1 where id=$2",
          [next,x.p.id]
        );
        await c.query(
          `insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note)
           values($1,'Venda',$2,$3,$4,$5)`,
          [x.p.id,x.quantity,previous,next,'Pedido #'+order.id+' • Mesa '+tableNumber]
        );
      }
    }

    await c.query("commit");
    res.json({ok:true,id:order.id,account_id:account.id,total});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(400).json({error:e.message||"Não foi possível criar o pedido."});
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

app.get("/api/stock",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`select p.id,p.name,p.emoji,p.price,p.cost_price,p.stock_quantity,p.stock_control,p.stock_low_threshold,c.name category
      from products p join categories c on c.id=p.category_id where p.active=true order by c.id,p.name`)).rows;
    res.json(rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar estoque."})}
});

app.put("/api/stock/costs/bulk",requireAdmin,async(req,res)=>{
  const items=Array.isArray(req.body&&req.body.items)?req.body.items:[];
  if(!items.length)return res.status(400).json({error:"Informe pelo menos um produto."});
  if(items.length>300)return res.status(400).json({error:"Muitos produtos em uma única atualização."});
  const normalized=[];
  for(const x of items){
    const id=Number(x&&x.id), cost=Math.max(0,Number(x&&x.cost_price)||0);
    if(!Number.isInteger(id)||id<=0||!Number.isFinite(cost))return res.status(400).json({error:"Existe um produto ou custo inválido."});
    normalized.push({id,cost});
  }
  const c=await pool.connect();
  try{
    await c.query("begin");
    let updated=0;
    for(const x of normalized){
      const r=await c.query("update products set cost_price=$1 where id=$2 and active=true",[x.cost,x.id]);
      updated+=r.rowCount;
    }
    await c.query("commit");
    res.json({ok:true,updated});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(500).json({error:"Erro ao salvar custos em lote."});
  }finally{c.release()}
});

app.put("/api/stock/:id",requireAdmin,async(req,res)=>{
  const quantity=Math.max(0,Math.floor(Number(req.body.quantity)||0));
  const control=Boolean(req.body.stock_control);
  const threshold=Math.max(0,Math.floor(Number(req.body.stock_low_threshold) || 0));
  const requestedCost=Number(req.body.cost_price);
  const hasCost=Number.isFinite(requestedCost)&&requestedCost>=0;
  const c=await pool.connect();
  try{
    await c.query("begin");
    const cur=await c.query("select id,name,stock_quantity,stock_control,cost_price from products where id=$1 and active=true for update",[Number(req.params.id)]);
    if(!cur.rowCount){await c.query("rollback");return res.status(404).json({error:"Produto não encontrado."});}
    const previous=Number(cur.rows[0].stock_quantity||0);
    const previousCost=Number(cur.rows[0].cost_price||0);
    const nextCost=hasCost?requestedCost:previousCost;
    const r=await c.query("update products set stock_quantity=$1,stock_control=$2,stock_low_threshold=$3,cost_price=$4 where id=$5 returning id,name,stock_quantity,stock_control,stock_low_threshold,cost_price",[quantity,control,threshold,nextCost,Number(req.params.id)]);
    if(previous!==quantity || Math.abs(previousCost-nextCost)>0.0001){
      const movementType=previous!==quantity?'Ajuste manual':'Ajuste de custo';
      const note=previous!==quantity?'Correção manual de estoque':'Atualização manual do custo unitário';
      await c.query(`insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note,previous_cost,new_cost)
        values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [Number(req.params.id),movementType,Math.abs(quantity-previous),previous,quantity,note,previousCost,nextCost]);
    }
    await c.query("commit");
    res.json(r.rows[0]);
  }catch(e){await c.query("rollback");res.status(500).json({error:"Erro ao atualizar estoque."})}
  finally{c.release()}
});

app.get("/api/stock/history",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`
      select sm.id,sm.product_id,p.name product_name,p.emoji,sm.movement_type,sm.quantity,
             sm.previous_quantity,sm.new_quantity,sm.previous_cost,sm.new_cost,sm.entry_unit_cost,sm.note,sm.created_at
      from stock_movements sm
      left join products p on p.id=sm.product_id
      order by sm.created_at desc,sm.id desc
      limit 300
    `)).rows;
    res.json(rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar histórico de estoque."})}
});


app.post("/api/stock/:id/entry",requireAdmin,async(req,res)=>{
  const quantity=Math.floor(Number(req.body.quantity)||0);
  const note=String(req.body.note||"").trim();
  const rawEntryCost=req.body.unit_cost;
  const entryCost=rawEntryCost===""||rawEntryCost===null||rawEntryCost===undefined?null:Number(rawEntryCost);
  if(quantity<=0)return res.status(400).json({error:"Informe uma quantidade de entrada maior que zero."});
  if(entryCost!==null&&(!Number.isFinite(entryCost)||entryCost<0))return res.status(400).json({error:"Informe um custo unitário válido."});

  const c=await pool.connect();
  try{
    await c.query("begin");
    const r=await c.query(
      "select id,name,stock_quantity,stock_control,cost_price from products where id=$1 and active=true for update",
      [Number(req.params.id)]
    );
    if(!r.rowCount){
      await c.query("rollback");
      return res.status(404).json({error:"Produto não encontrado."});
    }

    const p=r.rows[0];
    const previous=Number(p.stock_quantity||0);
    const previousCost=Number(p.cost_price||0);
    const next=previous+quantity;
    let nextCost=previousCost;
    if(entryCost!==null){
      nextCost=next>0?((previous*previousCost)+(quantity*entryCost))/next:entryCost;
      nextCost=Math.round(nextCost*100)/100;
    }

    await c.query(
      "update products set stock_quantity=$1,stock_control=true,cost_price=$2 where id=$3",
      [next,nextCost,p.id]
    );

    await c.query(
      `insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note,previous_cost,new_cost,entry_unit_cost)
       values($1,'Entrada',$2,$3,$4,$5,$6,$7,$8)`,
      [p.id,quantity,previous,next,note,previousCost,nextCost,entryCost]
    );

    await c.query("commit");
    res.json({ok:true,id:p.id,name:p.name,previous_quantity:previous,entry_quantity:quantity,stock_quantity:next,stock_control:true,previous_cost:previousCost,entry_unit_cost:entryCost,cost_price:nextCost});
  }catch(e){
    await c.query("rollback");
    console.error(e);
    res.status(500).json({error:"Erro ao registrar entrada de estoque."});
  }finally{
    c.release();
  }
});


app.get("/api/admin/categories",requireAdmin,async(req,res)=>{
  try{
    res.json((await pool.query("select id,name from categories order by id")).rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar categorias."})}
});

app.get("/api/orders",requireAdmin,async(req,res)=>{
  try{
    const orders=(await pool.query(`
      select o.*,
             a.status as account_status,
             a.payment_method as account_payment_method,
             a.closed_at as account_closed_at,
             a.account_type as account_type,
             a.customer_name as customer_name,
             exists(
               select 1 from pix_payments pp
               where pp.account_id=o.account_id
                 and lower(pp.status) in ('paid','processed','approved')
             ) as pix_verified
      from orders o
      left join table_accounts a on a.id=o.account_id
      order by o.id desc
    `)).rows;
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



app.post("/api/admin/orders/cleanup-old-48h",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query(`
      update orders
      set status='Entregue'
      where status in ('Recebido','Em preparo','Pronto')
        and created_at <= now() - interval '48 hours'
      returning id
    `);
    res.json({ok:true,updated:r.rowCount,ids:r.rows.map(x=>x.id)});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao limpar pedidos com 48 horas ou mais."});
  }
});

app.post("/api/admin/orders/cleanup-closed",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query(`
      update orders o
      set status='Entregue'
      from table_accounts a
      where o.account_id=a.id
        and a.status='Fechada'
        and o.status in ('Recebido','Em preparo','Pronto')
      returning o.id
    `);
    res.json({ok:true,updated:r.rowCount,ids:r.rows.map(x=>x.id)});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao encerrar pedidos antigos."});
  }
});

app.patch("/api/orders/:id",requireAdmin,async(req,res)=>{
  const allowed=["Recebido","Em preparo","Pronto","Entregue","Cancelado"];
  if(!allowed.includes(req.body.status)){
    return res.status(400).json({error:"Status inválido."});
  }
  const c=await pool.connect();
  try{
    await c.query("begin");
    const id=Number(req.params.id);
    const current=(await c.query("select status from orders where id=$1 for update",[id])).rows[0];
    if(!current){await c.query("rollback");return res.status(404).json({error:"Pedido não encontrado."});}
    const next=req.body.status;
    if(current.status!=="Cancelado" && next==="Cancelado"){
      const items=(await c.query(`select p.id,p.name,p.stock_quantity,oi.quantity from order_items oi
        join products p on p.id=oi.product_id where oi.order_id=$1 and p.stock_control=true for update`,[id])).rows;
      for(const x of items){
        const previous=Number(x.stock_quantity||0), q=Number(x.quantity||0), updated=previous+q;
        await c.query("update products set stock_quantity=$1 where id=$2",[updated,x.id]);
        await c.query(`insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note)
          values($1,'Cancelamento',$2,$3,$4,$5)`,[x.id,q,previous,updated,'Devolução do pedido #'+id]);
      }
    }else if(current.status==="Cancelado" && next!=="Cancelado"){
      const items=(await c.query(`select p.id,p.name,p.stock_quantity,oi.quantity from order_items oi
        join products p on p.id=oi.product_id where oi.order_id=$1 and p.stock_control=true for update`,[id])).rows;
      for(const x of items){
        const previous=Number(x.stock_quantity||0), q=Number(x.quantity||0);
        if(previous<q)throw Error(`Estoque insuficiente para ${x.name}.`);
        const updated=previous-q;
        await c.query("update products set stock_quantity=$1 where id=$2",[updated,x.id]);
        await c.query(`insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note)
          values($1,'Reativação',$2,$3,$4,$5)`,[x.id,q,previous,updated,'Pedido #'+id+' reativado']);
      }
    }
    await c.query("update orders set status=$1 where id=$2",[next,id]);
    await c.query("commit");
    res.json({ok:true});
  }catch(e){await c.query("rollback");res.status(500).json({error:e.message||"Erro ao atualizar status."})}
  finally{c.release()}
});

app.get("/api/client/account/:table",async(req,res)=>{
  try{
    const tableNumber=Number(req.params.table);
    if(!Number.isInteger(tableNumber)||!validTableAccess(tableNumber,req.query.t)){
      return res.status(403).json({error:"Acesso inválido à comanda."});
    }
    const account=(await pool.query(`select * from table_accounts where table_number=$1 and status='Aberta' and account_type='Mesa' order by id desc limit 1`,[tableNumber])).rows[0];
    if(!account)return res.json({open:false,table_number:tableNumber,orders:[],total:0});
    if(isStaleTableAccount(account))return res.status(409).json({error:staleTableAccountMessage(),stale:true});
    const orders=(await pool.query(`select id,status,observation,total,created_at from orders where account_id=$1 order by id`,[account.id])).rows;
    let total=0;
    for(const o of orders){
      o.items=(await pool.query(`select product_name name,quantity,unit_price from order_items where order_id=$1 order by id`,[o.id])).rows;
      if(o.status!=="Cancelado")total+=Number(o.total);
    }
    res.json({open:true,account:{id:account.id,table_number:account.table_number},orders,total});
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao carregar sua comanda."})}
});

app.post("/api/client/pix",async(req,res)=>{
  const tableNumber=Number(req.body.table);
  const token=String(req.body.token||"");
  // O cliente não precisa informar e-mail para pagar com PIX.
  // O Mercado Pago exige payer.email na criação da order, então usamos
  // um e-mail técnico interno que não aparece para o cliente.
  const email="pix@cantinhodosgigantes.com";

  if(!Number.isInteger(tableNumber)||tableNumber<1||!validTableAccess(tableNumber,token)){
    return res.status(403).json({error:"Acesso inválido à comanda."});
  }

  try{
    const cashSession=await getOpenCashSession(pool);
    if(!cashSession){
      return res.status(409).json({error:noOpenCashMessage(),cash_closed:true});
    }

    const account=(await pool.query(
      `select * from table_accounts where table_number=$1 and status='Aberta' order by id desc limit 1`,
      [tableNumber]
    )).rows[0];

    if(!account)return res.status(404).json({error:"Não há comanda aberta nesta mesa."});
    if(isStaleTableAccount(account))return res.status(409).json({error:staleTableAccountMessage(),stale:true});

    const comandaTotal=Number((await pool.query(
      `select coalesce(sum(total),0)::numeric total
       from orders
       where account_id=$1 and status<>'Cancelado'`,
      [account.id]
    )).rows[0].total);

    if(comandaTotal<=0)return res.status(400).json({error:"A comanda não possui valor para pagamento."});

    // Evita gerar vários PIX ativos para a mesma comanda e mesmo valor.
    const existing=(await pool.query(
      `select * from pix_payments
       where account_id=$1 and amount=$2 and status in ('pending','action_required','processing')
       order by id desc limit 1`,
      [account.id,comandaTotal]
    )).rows[0];

    if(existing){
      try{
        const current=await mercadoPago("/v1/orders/"+encodeURIComponent(existing.mp_order_id));
        const payment=current?.transactions?.payments?.[0]||{};
        const method=payment.payment_method||{};
        const rawStatus=String(payment.status||current.status||"pending");
        const paid=["processed","approved","paid"].includes(rawStatus.toLowerCase());
        await pool.query(`update pix_payments set status=$1,updated_at=now() where id=$2`,[paid?"paid":rawStatus,existing.id]);
        if(!paid && ["action_required","pending","processing"].includes(rawStatus.toLowerCase())){
          return res.json({
            ok:true,reused:true,payment_id:existing.id,amount:Number(existing.amount),
            qr_code:method.qr_code||existing.qr_code||"",
            qr_code_base64:method.qr_code_base64||existing.qr_code_base64||"",
            ticket_url:method.ticket_url||existing.ticket_url||"",
            status:rawStatus
          });
        }
      }catch(_e){}
    }

    const externalReference=`cantinho_${account.id}_${Date.now()}`;
    const data=await mercadoPago("/v1/orders",{
      method:"POST",
      headers:{"X-Idempotency-Key":crypto.randomUUID()},
      body:JSON.stringify({
        type:"online",
        external_reference:externalReference,
        total_amount:comandaTotal.toFixed(2),
        processing_mode:"automatic",
        payer:{email},
        transactions:{
          payments:[{
            amount:comandaTotal.toFixed(2),
            payment_method:{id:"pix",type:"bank_transfer"},
            expiration_time:"PT30M"
          }]
        }
      })
    });

    const payment=data?.transactions?.payments?.[0]||{};
    const method=payment.payment_method||{};
    const rawStatus=String(payment.status||data.status||"action_required");

    const saved=(await pool.query(
      `insert into pix_payments(
         account_id,table_number,mp_order_id,external_reference,amount,status,
         payer_email,qr_code,qr_code_base64,ticket_url
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [account.id,tableNumber,data.id,externalReference,comandaTotal,rawStatus,email,
       method.qr_code||"",method.qr_code_base64||"",method.ticket_url||""]
    )).rows[0];

    res.json({
      ok:true,production:true,payment_id:saved.id,amount:comandaTotal,
      qr_code:method.qr_code||"",qr_code_base64:method.qr_code_base64||"",
      ticket_url:method.ticket_url||"",status:rawStatus
    });
  }catch(e){
    console.error(e);
    res.status(400).json({error:e.message||"Não foi possível gerar o Pix."});
  }
});

app.get("/api/client/pix/:id/status",async(req,res)=>{
  try{
    const p=(await pool.query(`select * from pix_payments where id=$1`,[Number(req.params.id)])).rows[0];
    if(!p||!validTableAccess(p.table_number,req.query.t)){
      return res.status(404).json({error:"Pagamento não encontrado."});
    }

    // Se o PIX já foi conciliado localmente, responde imediatamente sem
    // consultar novamente o Mercado Pago. Isso deixa a verificação automática
    // rápida e mantém a rota idempotente.
    const localAccount=(await pool.query(
      `select status,payment_method,closed_at from table_accounts where id=$1`,
      [p.account_id]
    )).rows[0];
    if(String(p.status||"").toLowerCase()==="paid" && localAccount?.status==="Fechada"){
      return res.json({
        ok:true,paid:true,status:"paid",account_closed:true,
        payment_method:localAccount.payment_method||"PIX",
        closed_at:localAccount.closed_at||null,reconciled:{closed:0}
      });
    }

    const data=await mercadoPago("/v1/orders/"+encodeURIComponent(p.mp_order_id));
    const payment=data?.transactions?.payments?.[0]||{};
    const rawStatus=String(payment.status||data.status||"");
    const paid=["processed","approved","paid"].includes(rawStatus.toLowerCase());

    if(!paid){
      await pool.query(
        `update pix_payments set status=$1,updated_at=now() where id=$2`,
        [rawStatus||"pending",p.id]
      );
      return res.json({ok:true,paid:false,status:rawStatus||"pending",account_closed:false});
    }

    // Marca o pagamento local como pago antes da reconciliação.
    await pool.query(
      `update pix_payments set status='paid',updated_at=now() where id=$1`,
      [p.id]
    );

    // Fecha exatamente a comanda vinculada a este pagamento já confirmado.
    // A rotina é idempotente: uma comanda já fechada não é fechada novamente.
    const result=await reconcilePaidPixAccounts();

    const account=(await pool.query(
      `select status,payment_method,closed_at from table_accounts where id=$1`,
      [p.account_id]
    )).rows[0];

    res.json({
      ok:true,
      paid:true,
      status:rawStatus||"paid",
      account_closed:account?.status==="Fechada",
      payment_method:account?.payment_method||null,
      closed_at:account?.closed_at||null,
      reconciled:result
    });
  }catch(e){
    console.error(e);
    res.status(400).json({error:e.message||"Erro ao consultar o Pix."});
  }
});

app.post("/api/admin/pix/reconcile",requireAdmin,async(req,res)=>{
  try{
    const result=await reconcilePaidPixAccounts();
    res.json({ok:true,...result});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao reconciliar pagamentos PIX."});
  }
});

app.get("/api/accounts",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`
      select
        a.id,a.table_number,a.account_type,a.customer_name,a.status,a.payment_method,a.opened_at,a.closed_at,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
        count(o.id) filter(where o.status<>'Cancelado')::int order_count
      from table_accounts a
      left join orders o on o.account_id=a.id
      group by a.id
      having not (
        a.status='Aberta'
        and count(o.id) filter(where o.status<>'Cancelado')=0
      )
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


app.get("/api/accounts/:id",requireAdmin,async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const account=(await pool.query(`select * from table_accounts where id=$1`,[id])).rows[0];
    if(!account)return res.status(404).json({error:"Comanda não encontrada."});
    const orders=(await pool.query(`select * from orders where account_id=$1 order by id`,[id])).rows;
    let total=0;
    for(const o of orders){
      o.items=(await pool.query(`select product_name name,quantity,unit_price from order_items where order_id=$1 order by id`,[o.id])).rows;
      if(o.status!=="Cancelado")total+=Number(o.total);
    }
    res.json({open:account.status==="Aberta",account,orders,total});
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao carregar comanda."})}
});

app.post("/api/accounts/avulsa",requireAdmin,async(req,res)=>{
  const name=String(req.body.customer_name||"").trim();
  if(!name)return res.status(400).json({error:"Digite o nome ou identificação da comanda."});
  const c=await pool.connect();
  try{
    await c.query("begin");
    const seq=(await c.query(`select nextval(pg_get_serial_sequence('table_accounts','id'))::int id`)).rows[0].id;
    const account=(await c.query(`
      insert into table_accounts(id,table_number,account_type,customer_name,status)
      values($1,$2,'Avulsa',$3,'Aberta') returning *
    `,[seq,-seq,name])).rows[0];
    await c.query("commit");
    res.json({ok:true,account});
  }catch(e){try{await c.query("rollback")}catch(_e){};console.error(e);res.status(500).json({error:"Erro ao criar comanda avulsa."})}
  finally{c.release()}
});

app.post("/api/accounts/:id/orders",requireAdmin,async(req,res)=>{
  const items=Array.isArray(req.body.items)?req.body.items:[];
  const observation=String(req.body.observation||"");
  if(!items.length)return res.status(400).json({error:"Adicione pelo menos um produto."});
  if(items.length>50)return res.status(400).json({error:"Há itens demais neste pedido."});
  const c=await pool.connect();
  try{
    await c.query("begin");
    const account=(await c.query(`select * from table_accounts where id=$1 and status='Aberta' for update`,[Number(req.params.id)])).rows[0];
    if(!account)throw Error("Comanda aberta não encontrada.");
    let total=0; const normalized=[];
    for(const item of items){
      const rawQuantity=Number(item.quantity||1);
      if(!Number.isFinite(rawQuantity)||rawQuantity<1||rawQuantity>99)throw Error("Quantidade inválida. Use de 1 a 99 unidades por item.");
      const quantity=Math.floor(rawQuantity);
      const r=await c.query("select id,name,price,cost_price,stock_quantity,stock_control from products where id=$1 and active=true for update",[Number(item.product_id)]);
      if(!r.rowCount)throw Error("Produto inválido.");
      const p=r.rows[0],price=Number(p.price),cost=Number(p.cost_price||0);
      if(p.stock_control&&Number(p.stock_quantity)<quantity)throw Error(`Estoque insuficiente para ${p.name}. Disponível: ${p.stock_quantity}`);
      total+=price*quantity; normalized.push({p,quantity,price,cost});
    }
    const order=(await c.query(`insert into orders(account_id,table_number,status,observation,total) values($1,$2,'Recebido',$3,$4) returning id`,[account.id,account.table_number,observation,total])).rows[0];
    for(const x of normalized){
      await c.query(`insert into order_items(order_id,product_id,product_name,quantity,unit_price,unit_cost) values($1,$2,$3,$4,$5,$6)`,[order.id,x.p.id,x.p.name,x.quantity,x.price,x.cost]);
      if(x.p.stock_control){
        const previous=Number(x.p.stock_quantity||0),next=previous-x.quantity;
        await c.query("update products set stock_quantity=$1 where id=$2",[next,x.p.id]);
        await c.query(`insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note) values($1,'Venda',$2,$3,$4,$5)`,[x.p.id,x.quantity,previous,next,'Pedido #'+order.id+' • '+(account.account_type==='Avulsa'?'Comanda '+account.customer_name:'Mesa '+account.table_number)]);
      }
    }
    await c.query("commit");res.json({ok:true,id:order.id,total});
  }catch(e){try{await c.query("rollback")}catch(_e){};console.error(e);res.status(400).json({error:e.message||"Erro ao lançar pedido."})}
  finally{c.release()}
});

app.post("/api/accounts/:id/cancel",requireAdmin,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query("begin");

    const account=(await c.query(
      `select * from table_accounts where id=$1 and status='Aberta' for update`,
      [Number(req.params.id)]
    )).rows[0];

    if(!account){
      await c.query("rollback");
      return res.status(404).json({error:"Comanda aberta não encontrada."});
    }

    const pixRows=(await c.query(
      `select id,status from pix_payments
       where account_id=$1
       order by id desc
       for update`,
      [account.id]
    )).rows;

    const paidPix=pixRows.find(p=>["paid","processed","approved"].includes(String(p.status||"").toLowerCase()));
    if(paidPix){
      await c.query("rollback");
      return res.status(400).json({
        error:"Esta comanda possui um PIX já pago/aprovado. O cancelamento foi bloqueado por segurança."
      });
    }

    const pendingPix=pixRows.filter(p=>
      ["pending","action_required","processing"].includes(String(p.status||"").toLowerCase())
    );

    if(pendingPix.length){
      await c.query(
        `update pix_payments
         set status='cancelled',updated_at=now()
         where account_id=$1
           and lower(status) in ('pending','action_required','processing')`,
        [account.id]
      );
    }

    const orders=(await c.query(
      `select id from orders where account_id=$1 and status<>'Cancelado' order by id for update`,
      [account.id]
    )).rows;

    for(const o of orders){
      const items=(await c.query(`
        select p.id,p.stock_quantity,oi.quantity
        from order_items oi
        join products p on p.id=oi.product_id
        where oi.order_id=$1 and p.stock_control=true
        for update
      `,[o.id])).rows;

      for(const x of items){
        const previous=Number(x.stock_quantity||0);
        const q=Number(x.quantity||0);
        const updated=previous+q;
        await c.query("update products set stock_quantity=$1 where id=$2",[updated,x.id]);
        await c.query(`
          insert into stock_movements(product_id,movement_type,quantity,previous_quantity,new_quantity,note)
          values($1,'Cancelamento',$2,$3,$4,$5)
        `,[x.id,q,previous,updated,'Cancelamento da comanda • Pedido #'+o.id+' • '+(account.account_type==='Avulsa'?'Comanda '+account.customer_name:'Mesa '+account.table_number)]);
      }
      await c.query("update orders set status='Cancelado' where id=$1",[o.id]);
    }

    await c.query(`
      update table_accounts
      set status='Cancelada',payment_method=null,closed_at=now()
      where id=$1
    `,[account.id]);

    await c.query("commit");
    res.json({ok:true,account_id:account.id,table_number:account.table_number,cancelled_orders:orders.length,payment_method:null});
  }catch(e){
    try{await c.query("rollback")}catch(_e){}
    console.error(e);
    res.status(500).json({error:e.message||"Erro ao cancelar a comanda."});
  }finally{
    c.release();
  }
});


app.post("/api/accounts/:id/close",requireAdmin,async(req,res)=>{
  const payment=String(req.body.payment_method||"");
  if(payment!=="PIX"){
    return res.status(400).json({error:"Este sistema aceita fechamento somente em PIX."});
  }

  const c=await pool.connect();
  try{
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock($1)",[FINANCE_LOCK_KEY]);

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

    const cashSession=await getOpenCashSession(c);
    if(!cashSession){
      await c.query("rollback");
      return res.status(409).json({error:noOpenCashMessage(),cash_closed:true});
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
  const name=String(x.name||"").trim();
  const price=Number(x.price),categoryId=Number(x.category_id);
  if(!name||name.length>120||!Number.isFinite(price)||price<=0||!Number.isInteger(categoryId)||categoryId<1){
    return res.status(400).json({error:"Preencha nome, preço positivo e categoria válida."});
  }
  try{
    const r=await pool.query(
      `insert into products(name,description,price,category_id,emoji,image,active,stock_quantity,stock_control,cost_price,stock_low_threshold,wine_type,wine_grape,wine_origin,wine_vintage,wine_volume_ml)
       values($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [name,String(x.description||"").slice(0,500),price,categoryId,
       String(x.emoji||"🍽️"),String(x.image||""),Math.max(0,Math.floor(Number(x.stock_quantity)||0)),Boolean(x.stock_control),Math.max(0,Number(x.cost_price)||0),Math.max(0,Math.floor(Number(x.stock_low_threshold)||0)),
       String(x.wine_type||"").slice(0,80),String(x.wine_grape||"").slice(0,120),String(x.wine_origin||"").slice(0,140),String(x.wine_vintage||"").slice(0,20),Number.isFinite(Number(x.wine_volume_ml))&&Number(x.wine_volume_ml)>0?Math.floor(Number(x.wine_volume_ml)):null]
    );
    res.json(r.rows[0]);
  }catch(e){res.status(500).json({error:"Erro ao cadastrar produto."})}
});

app.put("/api/products/:id",requireAdmin,async(req,res)=>{
  const x=req.body;
  const name=String(x.name||"").trim();
  const price=Number(x.price),categoryId=Number(x.category_id);
  if(!name||name.length>120||!Number.isFinite(price)||price<=0||!Number.isInteger(categoryId)||categoryId<1){
    return res.status(400).json({error:"Preencha nome, preço positivo e categoria válida."});
  }
  try{
    await pool.query(
      `update products set name=$1,description=$2,price=$3,category_id=$4,emoji=$5,image=$6,stock_quantity=$7,stock_control=$8,cost_price=$9,stock_low_threshold=$10,wine_type=$11,wine_grape=$12,wine_origin=$13,wine_vintage=$14,wine_volume_ml=$15 where id=$16`,
      [name,String(x.description||"").slice(0,500),price,categoryId,
       String(x.emoji||"🍽️"),String(x.image||""),Math.max(0,Math.floor(Number(x.stock_quantity)||0)),Boolean(x.stock_control),Math.max(0,Number(x.cost_price)||0),Math.max(0,Math.floor(Number(x.stock_low_threshold)||0)),
       String(x.wine_type||"").slice(0,80),String(x.wine_grape||"").slice(0,120),String(x.wine_origin||"").slice(0,140),String(x.wine_vintage||"").slice(0,20),Number.isFinite(Number(x.wine_volume_ml))&&Number(x.wine_volume_ml)>0?Math.floor(Number(x.wine_volume_ml)):null,Number(req.params.id)]
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
    const tableNumber=Number(req.params.table);
    if(!Number.isInteger(tableNumber)||tableNumber<1){
      return res.status(400).json({error:"Mesa inválida."});
    }
    const exists=(await pool.query("select 1 from tables_restaurant where number=$1 limit 1",[tableNumber])).rowCount;
    if(!exists)return res.status(404).json({error:"Mesa não cadastrada."});
    const url=`${req.protocol}://${req.get("host")}/?mesa=${encodeURIComponent(tableNumber)}&t=${tableAccessToken(tableNumber)}`;
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

    let summary={pix:0,sales_total:0,count:0,mercado_pago_pix:0,manual_pix:0};
    let receipts=[];
    if(session){
      receipts=(await pool.query(`
        select
          a.id,
          a.table_number,
          a.account_type,
          a.customer_name,
          a.closed_at,
          coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
          count(o.id) filter(where o.status<>'Cancelado')::int order_count,
          exists(
            select 1 from pix_payments pp
            where pp.account_id=a.id
              and lower(pp.status) in ('paid','processed','approved')
          ) as mercado_pago_verified
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Fechada'
          and a.payment_method='PIX'
          and a.closed_at>= $1
        group by a.id
        order by a.closed_at desc,a.id desc
      `,[session.opened_at])).rows.map(x=>({
        ...x,
        total:Number(x.total),
        order_count:Number(x.order_count||0),
        payment_source:x.mercado_pago_verified?'Mercado Pago':'PIX manual'
      }));

      const mercadoPagoPix=receipts.filter(x=>x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
      const manualPix=receipts.filter(x=>!x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
      const total=mercadoPagoPix+manualPix;
      summary={
        pix:total,
        sales_total:total,
        count:receipts.length,
        mercado_pago_pix:mercadoPagoPix,
        manual_pix:manualPix
      };
    }
    const openAccounts=await getOpenAccountsSummary(pool);
    res.json({session,summary,receipts,open_accounts:openAccounts});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar caixa."});
  }
});

app.post("/api/cash/open",requireAdmin,async(req,res)=>{
  const opening=0;
  const c=await pool.connect();
  try{
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock($1)",[FINANCE_LOCK_KEY]);
    const exists=(await c.query("select id from cash_sessions where status='Aberto' limit 1 for update")).rowCount;
    if(exists){
      await c.query("rollback");
      return res.status(409).json({error:"Já existe um caixa aberto."});
    }
    const row=(await c.query(`
      insert into cash_sessions(opening_amount,status) values($1,'Aberto') returning *
    `,[opening])).rows[0];
    await c.query("commit");
    res.json({ok:true,session:row});
  }catch(e){
    try{await c.query("rollback")}catch(_e){}
    console.error(e);
    res.status(500).json({error:"Erro ao abrir caixa."});
  }finally{c.release()}
});

app.post("/api/cash/:id/close",requireAdmin,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock($1)",[FINANCE_LOCK_KEY]);
    const session=(await c.query(
      `select * from cash_sessions where id=$1 and status='Aberto' for update`,
      [Number(req.params.id)]
    )).rows[0];
    if(!session){
      await c.query("rollback");
      return res.status(404).json({error:"Caixa aberto não encontrado."});
    }

    const openAccounts=await getOpenAccountsSummary(c);
    if(openAccounts.count>0){
      await c.query("rollback");
      return res.status(409).json({
        error:`Não é possível fechar o caixa. Existem ${openAccounts.count} comanda(s) aberta(s), totalizando R$ ${openAccounts.total.toFixed(2).replace('.',',')}. Feche ou cancele as comandas antes de encerrar o caixa.`,
        open_accounts:openAccounts
      });
    }

    // O servidor é a fonte de verdade do fechamento: soma somente contas PIX
    // realmente fechadas durante esta sessão. O navegador não informa o total.
    const r=(await c.query(`
      select coalesce(sum(x.total),0)::numeric total
      from (
        select a.id,
               coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total
        from table_accounts a
        left join orders o on o.account_id=a.id
        where a.status='Fechada'
          and a.payment_method='PIX'
          and a.closed_at>= $1
        group by a.id
      ) x
    `,[session.opened_at])).rows[0];

    const received=Number(r.total);
    const row=(await c.query(`
      update cash_sessions
      set status='Fechado',closed_at=now(),closing_amount=$1,expected_amount=$1,notes=$2
      where id=$3
      returning *
    `,[received,String(req.body.notes||req.body.note||""),session.id])).rows[0];

    await c.query("commit");
    res.json({ok:true,session:row,total_received:received,difference:0});
  }catch(e){
    try{await c.query("rollback")}catch(_e){}
    console.error(e);
    res.status(500).json({error:"Erro ao fechar caixa."});
  }finally{c.release()}
});

app.get("/api/cash/history",requireAdmin,async(req,res)=>{
  try{
    res.json((await pool.query("select * from cash_sessions order by id desc limit 100")).rows);
  }catch(e){res.status(500).json({error:"Erro ao carregar histórico do caixa."})}
});

app.get("/api/cash/:id/details",requireAdmin,async(req,res)=>{
  try{
    const session=(await pool.query(
      `select * from cash_sessions where id=$1 limit 1`,
      [Number(req.params.id)]
    )).rows[0];
    if(!session)return res.status(404).json({error:"Caixa não encontrado."});

    const end=session.closed_at||new Date();
    const receipts=(await pool.query(`
      select
        a.id,
        a.table_number,
        a.account_type,
        a.customer_name,
        a.closed_at,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric total,
        count(o.id) filter(where o.status<>'Cancelado')::int order_count,
        exists(
          select 1 from pix_payments pp
          where pp.account_id=a.id
            and lower(pp.status) in ('paid','processed','approved')
        ) as mercado_pago_verified
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Fechada'
        and a.payment_method='PIX'
        and a.closed_at >= $1
        and a.closed_at <= $2
      group by a.id
      order by a.closed_at asc,a.id asc
    `,[session.opened_at,end])).rows.map(x=>({
      ...x,
      total:Number(x.total),
      order_count:Number(x.order_count||0),
      payment_source:x.mercado_pago_verified?'Mercado Pago':'PIX manual'
    }));

    const mercadoPagoPix=receipts.filter(x=>x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
    const manualPix=receipts.filter(x=>!x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
    const total=mercadoPagoPix+manualPix;
    res.json({
      session,
      summary:{
        mercado_pago_pix:mercadoPagoPix,
        manual_pix:manualPix,
        pix:total,
        sales_total:total,
        count:receipts.length
      },
      receipts
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro ao carregar detalhes do caixa."});
  }
});

app.get("/api/stats",requireAdmin,async(req,res)=>{
  try{
    // Corrige automaticamente comandas PIX que já foram pagas no Mercado Pago,
    // mas por algum motivo ainda ficaram abertas no banco.
    await reconcilePaidPixAccounts();
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
        having count(o.id) filter(where o.status<>'Cancelado')>0
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



app.get("/api/profit-rules",requireAdmin,async(req,res)=>{
  try{
    const rows=(await pool.query(`select normalized_name,display_name,alias_product_id,historical_unit_cost,ignored,updated_at from profit_historical_rules order by display_name`)).rows;
    res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao carregar regras históricas do lucro."})}
});

app.put("/api/profit-rules/:key",requireAdmin,async(req,res)=>{
  const key=String(req.params.key||"").trim();
  const name=String(req.body.display_name||key).trim();
  if(!key||!name)return res.status(400).json({error:"Produto histórico inválido."});
  const aliasRaw=req.body.alias_product_id;
  const alias=aliasRaw===null||aliasRaw===undefined||aliasRaw===""?null:Number(aliasRaw);
  const costRaw=req.body.historical_unit_cost;
  const cost=costRaw===null||costRaw===undefined||costRaw===""?null:Number(costRaw);
  const ignored=Boolean(req.body.ignored);
  if(alias!==null&&(!Number.isInteger(alias)||alias<=0))return res.status(400).json({error:"Produto associado inválido."});
  if(cost!==null&&(!Number.isFinite(cost)||cost<=0))return res.status(400).json({error:"Custo histórico inválido."});
  try{
    if(alias!==null){
      const exists=await pool.query("select id from products where id=$1",[alias]);
      if(!exists.rowCount)return res.status(404).json({error:"Produto associado não encontrado."});
    }
    const row=(await pool.query(`
      insert into profit_historical_rules(normalized_name,display_name,alias_product_id,historical_unit_cost,ignored,updated_at)
      values($1,$2,$3,$4,$5,now())
      on conflict(normalized_name) do update set
        display_name=excluded.display_name,
        alias_product_id=coalesce(excluded.alias_product_id,profit_historical_rules.alias_product_id),
        historical_unit_cost=coalesce(excluded.historical_unit_cost,profit_historical_rules.historical_unit_cost),
        ignored=excluded.ignored,updated_at=now()
      returning *`,[key,name,alias,cost,ignored])).rows[0];
    res.json(row);
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao salvar regra histórica do lucro."})}
});

app.get("/api/reports/period",requireAdmin,async(req,res)=>{
  try{
    const start=String(req.query.start||"").trim();
    const end=String(req.query.end||"").trim();

    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)){
      return res.status(400).json({error:"Período inválido."});
    }

    if(start>end){
      return res.status(400).json({error:"A data inicial não pode ser maior que a data final."});
    }

    const accounts=(await pool.query(`
      select
        a.id,
        a.payment_method,
        a.closed_at,
        coalesce(sum(case when o.status<>'Cancelado' then o.total else 0 end),0)::numeric as total,
        exists(
          select 1 from pix_payments pp
          where pp.account_id=a.id
            and lower(pp.status) in ('paid','processed','approved')
        ) as mercado_pago_verified
      from table_accounts a
      left join orders o on o.account_id=a.id
      where a.status='Fechada'
        and a.closed_at >= ($1::date at time zone 'America/Sao_Paulo')
        and a.closed_at < (($2::date + interval '1 day') at time zone 'America/Sao_Paulo')
      group by a.id,a.payment_method,a.closed_at
      order by a.closed_at
    `,[start,end])).rows;

    let pix=0,dinheiro=0,cartao=0,total=0,mercadoPagoPix=0,manualPix=0;
    for(const a of accounts){
      const value=Number(a.total);
      total+=value;
      if(a.payment_method==="PIX"){
        pix+=value;
        if(a.mercado_pago_verified)mercadoPagoPix+=value;
        else manualPix+=value;
      }
      else if(a.payment_method==="Dinheiro")dinheiro+=value;
      else if(a.payment_method==="Cartão")cartao+=value;
    }

    const products=(await pool.query(`
      select
        oi.product_name as name,
        sum(oi.quantity)::int as quantity,
        sum(oi.quantity*oi.unit_price)::numeric as total
      from order_items oi
      join orders o on o.id=oi.order_id
      join table_accounts a on a.id=o.account_id
      where a.status='Fechada'
        and o.status<>'Cancelado'
        and a.closed_at >= ($1::date at time zone 'America/Sao_Paulo')
        and a.closed_at < (($2::date + interval '1 day') at time zone 'America/Sao_Paulo')
      group by oi.product_name
      order by sum(oi.quantity) desc,sum(oi.quantity*oi.unit_price) desc
    `,[start,end])).rows;

    const financial=(await pool.query(`
      select
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is not null then oi.quantity * coalesce(oi.unit_cost,p.cost_price) else 0 end),0)::numeric as known_cost,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is not null then oi.quantity * oi.unit_price else 0 end),0)::numeric as known_revenue,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is null then oi.quantity * oi.unit_price else 0 end),0)::numeric as missing_revenue,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is null then oi.quantity else 0 end),0)::int as missing_items
      from order_items oi
      join orders o on o.id=oi.order_id
      join table_accounts a on a.id=o.account_id
      left join products p on p.id=oi.product_id
      where a.status='Fechada'
        and o.status<>'Cancelado'
        and a.closed_at >= ($1::date at time zone 'America/Sao_Paulo')
        and a.closed_at < (($2::date + interval '1 day') at time zone 'America/Sao_Paulo')
    `,[start,end])).rows[0];

    const byDay={};
    for(const a of accounts){
      const d=new Date(a.closed_at);
      const key=new Intl.DateTimeFormat("en-CA",{
        timeZone:"America/Sao_Paulo",
        year:"numeric",month:"2-digit",day:"2-digit"
      }).format(d);
      if(!byDay[key])byDay[key]={day:key,contas:0,total:0};
      byDay[key].contas++;
      byDay[key].total+=Number(a.total);
    }

    const days=Object.values(byDay).sort((a,b)=>a.day.localeCompare(b.day));
    const items=products.reduce((n,p)=>n+Number(p.quantity),0);
    const contas=accounts.length;

    res.json({
      start,end,
      summary:{
        total,
        pix,
        mercado_pago_pix:mercadoPagoPix,
        manual_pix:manualPix,
        dinheiro,
        cartao,
        contas,
        ticket_medio:contas?total/contas:0,
        itens:items,
        custo:Number(financial.known_cost),
        faturamento_com_custo:Number(financial.known_revenue),
        faturamento_sem_custo:Number(financial.missing_revenue),
        itens_sem_custo:Number(financial.missing_items),
        cobertura_custos:total>0?(Number(financial.known_revenue)/total)*100:100,
        lucro_bruto_parcial:Number(financial.known_revenue)-Number(financial.known_cost),
        lucro_bruto:Number(financial.missing_items)>0?null:total-Number(financial.known_cost)
      },
      products:products.map(x=>({...x,total:Number(x.total)})),
      days
    });
  }catch(e){
    console.error("ERRO RELATORIO PERIODO:",e);
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
        count(o.id) filter(where o.status<>'Cancelado')::int order_count,
        exists(
          select 1 from pix_payments pp
          where pp.account_id=a.id
            and lower(pp.status) in ('paid','processed','approved')
        ) as mercado_pago_verified
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

    const financial=(await pool.query(`
      select
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is not null then oi.quantity * coalesce(oi.unit_cost,p.cost_price) else 0 end),0)::numeric as known_cost,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is not null then oi.quantity * oi.unit_price else 0 end),0)::numeric as known_revenue,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is null then oi.quantity * oi.unit_price else 0 end),0)::numeric as missing_revenue,
        coalesce(sum(case when coalesce(oi.unit_cost,p.cost_price) is null then oi.quantity else 0 end),0)::int as missing_items
      from order_items oi
      join orders o on o.id=oi.order_id
      join table_accounts a on a.id=o.account_id
      left join products p on p.id=oi.product_id
      where a.status='Fechada'
        and o.status<>'Cancelado'
        and (a.closed_at at time zone 'America/Sao_Paulo')::date=$1::date
    `,[date])).rows[0];

    const cash=(await pool.query(`
      select * from cash_sessions
      where status='Fechado'
        and (closed_at at time zone 'America/Sao_Paulo')::date=$1::date
      order by closed_at desc
    `,[date])).rows;

    const normalizedAccounts=accounts.map(x=>({
      ...x,
      total:Number(x.total),
      order_count:Number(x.order_count||0),
      payment_source:x.payment_method==='PIX'?(x.mercado_pago_verified?'Mercado Pago':'PIX manual'):(x.payment_method||'-')
    }));
    const mercadoPagoPix=normalizedAccounts.filter(x=>x.payment_method==='PIX'&&x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
    const manualPix=normalizedAccounts.filter(x=>x.payment_method==='PIX'&&!x.mercado_pago_verified).reduce((z,x)=>z+Number(x.total||0),0);
    const itens=products.reduce((z,x)=>z+Number(x.quantity||0),0);
    const totalValue=Number(summary.total);
    const contasCount=Number(summary.contas||0);

    res.json({
      date,
      summary:{
        total:totalValue,
        pix:Number(summary.pix),
        mercado_pago_pix:mercadoPagoPix,
        manual_pix:manualPix,
        dinheiro:Number(summary.dinheiro),
        cartao:Number(summary.cartao),
        contas:contasCount,
        ticket_medio:contasCount?totalValue/contasCount:0,
        itens,
        custo:Number(financial.known_cost),
        faturamento_com_custo:Number(financial.known_revenue),
        faturamento_sem_custo:Number(financial.missing_revenue),
        itens_sem_custo:Number(financial.missing_items),
        cobertura_custos:totalValue>0?(Number(financial.known_revenue)/totalValue)*100:100,
        lucro_bruto_parcial:Number(financial.known_revenue)-Number(financial.known_cost),
        lucro_bruto:Number(financial.missing_items)>0?null:totalValue-Number(financial.known_cost)
      },
      accounts:normalizedAccounts,
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

let pixAutoReconcileBusy=false;
function startPixAutoReconcile(){
  // Segurança adicional: mesmo que o cliente feche a tela do QR Code, o
  // servidor continua conciliando PIX pendentes em segundo plano.
  const timer=setInterval(async()=>{
    if(pixAutoReconcileBusy)return;
    pixAutoReconcileBusy=true;
    try{await reconcilePaidPixAccounts()}
    catch(e){console.error("Conciliação automática PIX:",e.message||e)}
    finally{pixAutoReconcileBusy=false}
  },20000);
  if(typeof timer.unref==="function")timer.unref();
}

init()
  .then(()=>app.listen(PORT,()=>{
    console.log("Cantinho dos Gigantes rodando na porta "+PORT);
    startPixAutoReconcile();
  }))
  .catch(e=>{
    console.error("Erro na inicialização:",e);
    process.exit(1);
  });
